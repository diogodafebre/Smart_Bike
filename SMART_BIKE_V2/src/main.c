#include <stdio.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/unistd.h>

#include "driver/gpio.h"
#include "driver/i2c.h"
#include "driver/spi_master.h"
#include "esp_adc/adc_oneshot.h"
#include "esp_log.h"
#include "esp_vfs_fat.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "sdmmc_cmd.h"

// Définition des Pins et Canaux pour ESP32-C3
// GPIO 0 correspond au Canal 0 de l'ADC 1
#define ADC1_CHAN0 ADC_CHANNEL_0
// GPIO 5 correspond au Canal 0 de l'ADC 2
#define ADC2_CHAN0 ADC_CHANNEL_0

// Define GPIO inputs analog
#define FSR_B 0  // ADC1 - CH0
#define FSR_A 5  // ADC2 - CH0

// Define GPIO inputs digital
#define BUTTON_GPIO 1  // not used

// Define GPIO outputs
#define LED_GPIO 2    // not used
#define FSR_SEL_A0 3  // for selecting the FSR (mux 2 x 4-to-1)
#define FSR_SEL_A1 4  // for selecting the FSR (mux 2 x 4-to-1)

// Define SD card pins
#define SD_CS 4
#define SD_DI 7
#define SD_CLK 8
#define SD_DO 9

// Define i2c pins for ICM-42670-P
#define I2C_SDA 10
#define I2C_SCL 8

// Define constants
#define FSR_COUNT 8
#define SAMPLING_PERIOD_MS 10
#define ICM_ADDRESS 0x68
#define SD_MOUNT_POINT "/sd"

#define I2C_MASTER_SDA_IO I2C_SDA
#define I2C_MASTER_SCL_IO I2C_SCL
#define I2C_MASTER_FREQ_HZ 100000
#define I2C_MASTER_NUM I2C_NUM_0
#define TIMEOUT_MS 50

static const char* TAG = "MAIN";

void app_main(void) {
    // Set pin 6 to output to low
    ESP_LOGI(TAG, "START");

    // Test GPIO outputs
    uint8_t io[] = { 1, 2, 6, 7, 3, 4, 8, 10 };
    uint8_t index = 0;
    gpio_config_t out_conf = { .pin_bit_mask =
                                   (1ULL << 6) | (1ULL << 7) | (1ULL << 3) | (1ULL << 4) | (1ULL << 8) | (1ULL << 10) | (1ULL << 1) | (1ULL << 2),
                               .mode = GPIO_MODE_OUTPUT,
                               .pull_up_en = GPIO_PULLUP_DISABLE,
                               .pull_down_en = GPIO_PULLDOWN_DISABLE,
                               .intr_type = GPIO_INTR_DISABLE };

    gpio_config(&out_conf);
    static uint8_t level = 0;
    while (1) {
        for (int i = 0; i < 6; i++) {
            gpio_set_level(io[i], index & (1 << i) ? 1 : 0);
        }
        index++;
        // index %= 64;
        ESP_LOGI(TAG, "IO Level: %02X", index);
        vTaskDelay(pdMS_TO_TICKS(100));
    }

    // // Test i2c - Va tester tous les adresses i2c de 1 à 127 et afficher les adresses qui répondent
    // ESP_LOGI(TAG, "Testing I2C device...");
    uint8_t addr = 0x00;

    while (1) {
        i2c_config_t conf = {
            .mode = I2C_MODE_MASTER,
            .sda_io_num = I2C_MASTER_SDA_IO,
            .scl_io_num = I2C_MASTER_SCL_IO,
            .sda_pullup_en = GPIO_PULLUP_ENABLE,  // Active les résistances internes
            .scl_pullup_en = GPIO_PULLUP_ENABLE,
            .master.clk_speed = I2C_MASTER_FREQ_HZ,
        };

        esp_err_t err = i2c_param_config(I2C_MASTER_NUM, &conf);
        if (err != ESP_OK) {
            ESP_LOGE(TAG, "Erreur config I2C");
            return;
        }

        err = i2c_driver_install(I2C_MASTER_NUM, conf.mode, 0, 0, 0);
        if (err != ESP_OK) {
            ESP_LOGE(TAG, "Erreur installation driver I2C");
            return;
        }

        ESP_LOGI(TAG, "Scanner prêt. Début du scan en boucle...");

        while (1) {
            ESP_LOGI(TAG, "--- Scan en cours ---");
            int devices_found = 0;

            // On teste toutes les adresses possibles (1 à 127)
            for (int i = 1; i < 127; i++) {
                // i = 0x68;
                i2c_cmd_handle_t cmd = i2c_cmd_link_create();
                i2c_master_start(cmd);
                // On envoie l'adresse + bit d'écriture (0) pour voir si on reçoit un ACK
                i2c_master_write_byte(cmd, (i << 1) | I2C_MASTER_WRITE, true);
                i2c_master_stop(cmd);

                esp_err_t ret = i2c_master_cmd_begin(I2C_MASTER_NUM, cmd, pdMS_TO_TICKS(TIMEOUT_MS));
                i2c_cmd_link_delete(cmd);

                if (ret == ESP_OK) {
                    ESP_LOGI(TAG, "Périphérique trouvé à l'adresse: 0x%02X", i);
                    devices_found++;
                }
            }

            if (devices_found == 0) {
                ESP_LOGW(TAG, "Aucun périphérique I2C trouvé !");
            } else {
                ESP_LOGI(TAG, "Fin du scan. %d périphérique(s) trouvé(s).", devices_found);
            }
            ESP_LOGI(TAG, "RETRY");
            vTaskDelay(pdMS_TO_TICKS(2000));  // Pause de 2 secondes avant de recommencer
        }
    }

    // Test analog inputs
    adc_oneshot_unit_handle_t adc1_handle;
    adc_oneshot_unit_init_cfg_t init_config1 = {
        .unit_id = ADC_UNIT_1,
        .ulp_mode = ADC_ULP_MODE_DISABLE,
    };
    ESP_ERROR_CHECK(adc_oneshot_new_unit(&init_config1, &adc1_handle));

    // --- 2. Initialisation de l'Unité ADC 2 (Pour GPIO 5) ---
    adc_oneshot_unit_handle_t adc2_handle;
    adc_oneshot_unit_init_cfg_t init_config2 = {
        .unit_id = ADC_UNIT_2,
        .ulp_mode = ADC_ULP_MODE_DISABLE,
    };
    ESP_ERROR_CHECK(adc_oneshot_new_unit(&init_config2, &adc2_handle));

    // --- 3. Configuration des Canaux (Atténuation) ---
    // ATTEN_DB_12 permet de lire jusqu'à env. 3.0V - 3.3V (Full Range)
    // Si on laisse par défaut, ça sature à 1.1V
    adc_oneshot_chan_cfg_t config = {
        .bitwidth = ADC_BITWIDTH_DEFAULT,  // Résolution 12 bits (0-4095)
        .atten = ADC_ATTEN_DB_11,
    };

    ESP_ERROR_CHECK(adc_oneshot_config_channel(adc1_handle, ADC1_CHAN0, &config));
    ESP_ERROR_CHECK(adc_oneshot_config_channel(adc2_handle, ADC2_CHAN0, &config));

    ESP_LOGI(TAG, "ADC Initialisés. Lecture en boucle...");

    // Variables pour stocker les résultats
    int adc_raw_b = 0;  // FSR_B (GPIO 0)
    int adc_raw_a = 0;  // FSR_A (GPIO 5)

    while (1) {
        // Lecture ADC1 (GPIO 0)
        ESP_ERROR_CHECK(adc_oneshot_read(adc1_handle, ADC1_CHAN0, &adc_raw_b));

        // Lecture ADC2 (GPIO 5)
        ESP_ERROR_CHECK(adc_oneshot_read(adc2_handle, ADC2_CHAN0, &adc_raw_a));

        // Affichage dans le terminal
        // 0 = 0V, ~4095 = 3.3V
        ESP_LOGI(TAG, "FSR_B (GPIO 0): %d  |  FSR_A (GPIO 5): %d", adc_raw_b, adc_raw_a);

        vTaskDelay(pdMS_TO_TICKS(500));  // Pause de 500ms
    }

    // (Optionnel) Nettoyage si on sortait de la boucle
    adc_oneshot_del_unit(adc1_handle);
    adc_oneshot_del_unit(adc2_handle);

    vTaskDelay(pdMS_TO_TICKS(1000));
    ESP_LOGI(TAG, "...");

    vTaskDelay(pdMS_TO_TICKS(4000));
    ESP_LOGI(TAG, "Initialisation SD Card");

    esp_err_t ret;

    // 1. Configuration du montage (Mount Config)
    esp_vfs_fat_sdmmc_mount_config_t mount_config = { .format_if_mount_failed = true,  // Formater si le montage échoue (carte neuve ou corrompue)
                                                      .max_files = 5,
                                                      .allocation_unit_size = 16 * 1024 };

    sdmmc_card_t* card;
    const char mount_point[] = SD_MOUNT_POINT;
    ESP_LOGI(TAG, "Initialisation de la carte SD via SPI...");

    // 2. Configuration du Bus SPI
    // Note: On utilise SDSPI_HOST_DEFAULT() qui pointe généralement vers SPI2
    sdmmc_host_t host = SDSPI_HOST_DEFAULT();

    spi_bus_config_t bus_cfg = {
        .mosi_io_num = SD_DI,
        .miso_io_num = SD_DO,
        .sclk_io_num = SD_CLK,
        .quadwp_io_num = -1,
        .quadhd_io_num = -1,
        .max_transfer_sz = 4000,
    };

    // Initialisation du bus SPI
    ret = spi_bus_initialize(host.slot, &bus_cfg, SDSPI_DEFAULT_DMA);
    if (ret != ESP_OK) {
        ESP_LOGE(TAG, "Échec de l'initialisation du bus SPI.");
        return;
    }

    // 3. Configuration du slot (CS Pin)
    sdspi_device_config_t slot_config = SDSPI_DEVICE_CONFIG_DEFAULT();
    slot_config.gpio_cs = SD_CS;
    slot_config.host_id = host.slot;

    // 4. Montage du système de fichiers
    ret = esp_vfs_fat_sdspi_mount(mount_point, &host, &slot_config, &mount_config, &card);

    if (ret != ESP_OK) {
        if (ret == ESP_FAIL) {
            ESP_LOGE(TAG, "Échec du montage du système de fichiers.");
        } else {
            ESP_LOGE(TAG, "Échec de l'initialisation de la carte (%s).", esp_err_to_name(ret));
        }
        return;  // On arrête si pas de SD
    }

    ESP_LOGI(TAG, "Carte SD montée avec succès sur %s", mount_point);
    sdmmc_card_print_info(stdout, card);

    // --- BOUCLE PRINCIPALE ---
    int counter = 0;
    const char* file_path = SD_MOUNT_POINT "/log.txt";

    while (1) {
        ESP_LOGI(TAG, "Écriture du compteur: %d", counter);

        // Ouverture du fichier en mode "append" ('a')
        // Si le fichier n'existe pas, il est créé.
        // Si il existe, on écrit à la fin.
        FILE* f = fopen(file_path, "a");

        if (f == NULL) {
            ESP_LOGE(TAG, "Impossible d'ouvrir le fichier pour écriture");
        } else {
            // Écriture de la ligne
            fprintf(f, "Counter value: %d\n", counter);

            // Il est CRUCIAL de fermer le fichier pour sauvegarder physiquement les données
            fclose(f);
        }

        counter++;
        vTaskDelay(pdMS_TO_TICKS(1000));  // Pause de 1 seconde
    }
}