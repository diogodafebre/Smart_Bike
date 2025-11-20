#include <stdio.h>
#include <string.h>
#include <sys/stat.h>

#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

#include "esp_system.h"
#include "esp_log.h"
#include "esp_err.h"

#include "driver/gpio.h"
#include "driver/spi_master.h"
#include "driver/adc.h"          // ADC1 + ADC2 legacy (comme dans tes exemples qui marchent)

#include "esp_vfs_fat.h"
#include "sdmmc_cmd.h"
#include "esp_timer.h"
#include "esp_task_wdt.h"        // <-- pour désactiver le Task Watchdog

static const char *TAG = "SMART_BIKE_RUN";

// === Brochage ===
// LED_RUN     -> GPIO2 (active HIGH)
// BTN_RUN     -> GPIO1 (bouton vers GND, pull-up interne)
// FSR_B (droite) -> ADC1_CH0 / GPIO0
// FSR_A (gauche) -> ADC2_CH0 / GPIO5
// MUX S1      -> GPIO3
// MUX S0      -> GPIO4
// SD SPI      : CS=6, MOSI=7, SCK=8, MISO=9

#define PIN_LED_RUN    2
#define PIN_BTN_RUN    1

#define PIN_MUX_S1     3
#define PIN_MUX_S0     4

#define PIN_SD_CS      6
#define PIN_SD_MOSI    7
#define PIN_SD_SCK     8
#define PIN_SD_MISO    9

// ADC channels
#define ADC1_CH_FSR_B  ADC1_CHANNEL_0   // GPIO0
#define ADC2_CH_FSR_A  ADC2_CHANNEL_0   // GPIO5

// Paramètres
#define SAMPLE_PERIOD_MS   50   // <- 100 ms entre 2 acquisitions
#define MUX_SETTLE_MS        4   // temps de stabilisation du MUX
#define LED_BLINK_MS       200   // période de clignotement LED
#define BTN_DEBOUNCE_MS     50   // anti-rebond bouton
#define VREF_MV           3300   // approx 3.3 V

// Macros LED (active HIGH)
static inline void led_on(void)  { gpio_set_level(PIN_LED_RUN, 1); }
static inline void led_off(void) { gpio_set_level(PIN_LED_RUN, 0); }
static inline void led_toggle(void)
{
    int lvl = gpio_get_level(PIN_LED_RUN);
    gpio_set_level(PIN_LED_RUN, !lvl);
}

// État global RUN
static bool   g_run_active          = false;
static int    g_run_id              = 0;
static FILE  *g_run_file            = NULL;
static int    g_samples_since_flush = 0;

// SD
static bool          g_sd_ready = false;
static sdmmc_card_t *g_sd_card  = NULL;

// Temps
static int64_t g_run_start_us       = 0;
static int64_t g_last_sample_us     = 0;
static int64_t g_last_led_toggle_us = 0;

// Bouton
static int     g_btn_stable_state   = 1;    // pull-up -> repos = HIGH

// ==== Util GPIO / MUX ====

static void mux_select(uint8_t ch)
{
    // ch = 0..3
    gpio_set_level(PIN_MUX_S0, (ch & 0x01) ? 1 : 0);
    gpio_set_level(PIN_MUX_S1, (ch & 0x02) ? 1 : 0);
}

static void gpio_init_all(void)
{
    // LED + MUX en sortie
    gpio_config_t out_conf = {
        .pin_bit_mask = (1ULL << PIN_LED_RUN) |
                        (1ULL << PIN_MUX_S0) |
                        (1ULL << PIN_MUX_S1),
        .mode = GPIO_MODE_OUTPUT,
        .pull_up_en = GPIO_PULLUP_DISABLE,
        .pull_down_en = GPIO_PULLDOWN_DISABLE,
        .intr_type = GPIO_INTR_DISABLE
    };
    gpio_config(&out_conf);

    // Bouton en entrée avec pull-up
    gpio_config_t btn_conf = {
        .pin_bit_mask = (1ULL << PIN_BTN_RUN),
        .mode = GPIO_MODE_INPUT,
        .pull_up_en = GPIO_PULLUP_ENABLE,
        .pull_down_en = GPIO_PULLDOWN_DISABLE,
        .intr_type = GPIO_INTR_DISABLE
    };
    gpio_config(&btn_conf);

    led_off();
    mux_select(0);

    ESP_LOGI(TAG, "GPIO init OK");
}

// ==== ADC ====

static void adc_init_all(void)
{
    // ADC1 : FSR_B (GPIO0)
    adc1_config_width(ADC_WIDTH_BIT_12);
    adc1_config_channel_atten(ADC1_CH_FSR_B, ADC_ATTEN_DB_11);  // ~0..3.3V

    // ADC2 : FSR_A (GPIO5)
    esp_err_t err = adc2_config_channel_atten(ADC2_CH_FSR_A, ADC_ATTEN_DB_11);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "adc2_config_channel_atten failed: %s", esp_err_to_name(err));
    } else {
        ESP_LOGI(TAG, "ADC2 channel config OK");
    }

    ESP_LOGI(TAG, "ADC init OK (ADC1:GPIO0, ADC2:GPIO5)");
}

// Lit un capteur FSR_B (ADC1) + FSR_A (ADC2) pour une position de MUX
static void read_fsr_pair(int *mv_b, int *mv_a, esp_err_t *err_a)
{
    // FSR_B (ADC1)
    int raw_b = adc1_get_raw(ADC1_CH_FSR_B);
    *mv_b = (raw_b * VREF_MV) / 4095;

    // FSR_A (ADC2)
    int raw_a = 0;
    *err_a = adc2_get_raw(ADC2_CH_FSR_A, ADC_WIDTH_BIT_12, &raw_a);
    if (*err_a == ESP_OK) {
        *mv_a = (raw_a * VREF_MV) / 4095;
    } else {
        *mv_a = 0;
    }
}

// ==== SD ====

static esp_err_t sdcard_init(void)
{
    esp_err_t ret;

    ESP_LOGI(TAG, "Init SD (SPI2)…");

    spi_bus_config_t bus_cfg = {
        .mosi_io_num = PIN_SD_MOSI,
        .miso_io_num = PIN_SD_MISO,
        .sclk_io_num = PIN_SD_SCK,
        .quadwp_io_num = -1,
        .quadhd_io_num = -1,
        .max_transfer_sz = 4000,
    };
    ret = spi_bus_initialize(SPI2_HOST, &bus_cfg, SDSPI_DEFAULT_DMA);
    if (ret != ESP_OK && ret != ESP_ERR_INVALID_STATE) {
        ESP_LOGE(TAG, "spi_bus_initialize failed: %s", esp_err_to_name(ret));
        return ret;
    }

    sdmmc_host_t host = SDSPI_HOST_DEFAULT();
    host.slot = SPI2_HOST;

    sdspi_device_config_t slot_config = SDSPI_DEVICE_CONFIG_DEFAULT();
    slot_config.gpio_cs = PIN_SD_CS;
    slot_config.host_id = host.slot;

    esp_vfs_fat_sdmmc_mount_config_t mount_config = {
        .format_if_mount_failed = false,
        .max_files = 8,
        .allocation_unit_size = 16 * 1024,
    };

    ret = esp_vfs_fat_sdspi_mount("/sdcard", &host, &slot_config,
                                  &mount_config, &g_sd_card);
    if (ret != ESP_OK) {
        ESP_LOGE(TAG, "esp_vfs_fat_sdspi_mount failed: %s", esp_err_to_name(ret));
        return ret;
    }

    sdmmc_card_print_info(stdout, g_sd_card);
    ESP_LOGI(TAG, "SD montée sur /sdcard");
    g_sd_ready = true;
    return ESP_OK;
}

// trouve le prochain index RUNX.CSV libre
static int find_next_run_index(void)
{
    int idx = 1;
    char path[64];
    struct stat st;
    while (1) {
        snprintf(path, sizeof(path), "/sdcard/RUN%d.CSV", idx);
        if (stat(path, &st) != 0) {
            return idx;
        }
        ++idx;
    }
}

// ==== RUN start/stop ====

static void stop_run(void);

static void start_run(void)
{
    if (!g_sd_ready) {
        if (sdcard_init() != ESP_OK) {
            ESP_LOGE(TAG, "SD KO, impossible de démarrer un RUN");
            return;
        }
    }

    g_run_id = find_next_run_index();
    char path[64];
    snprintf(path, sizeof(path), "/sdcard/RUN%d.CSV", g_run_id);

    ESP_LOGI(TAG, "Start RUN %d -> %s", g_run_id, path);

    g_run_file = fopen(path, "w");
    if (!g_run_file) {
        ESP_LOGE(TAG, "fopen(%s) failed", path);
        g_run_active = false;
        return;
    }

    // Header CSV
    fprintf(g_run_file, "run,time_run_ms,capteur,value_V\n");
    fflush(g_run_file);
    g_samples_since_flush = 0;

    int64_t now_us = esp_timer_get_time();
    g_run_start_us       = now_us;
    g_last_sample_us     = now_us;
    g_last_led_toggle_us = now_us;
    led_on();

    g_run_active = true;
    ESP_LOGI(TAG, "RUN %d démarré", g_run_id);
}

static void stop_run(void)
{
    if (g_run_active) {
        ESP_LOGI(TAG, "Stop RUN %d", g_run_id);
        if (g_run_file) {
            fflush(g_run_file);
            fclose(g_run_file);
            g_run_file = NULL;
        }
    }
    g_run_active = false;
    led_off();
}

// ==== Bouton + LED ====

// gestion du bouton (toggle RUN sur front descendant)
static void handle_button(int64_t now_us)
{
    static int      last_reading = 1;
    static int64_t  last_change_us = 0;

    int reading = gpio_get_level(PIN_BTN_RUN);

    if (reading != last_reading) {
        last_change_us = now_us;  // changement brut
        last_reading   = reading;
    }

    int64_t delta_ms = (now_us - last_change_us) / 1000;
    if (delta_ms >= BTN_DEBOUNCE_MS) {
        if (reading != g_btn_stable_state) {
            g_btn_stable_state = reading;

            // front descendant (1 -> 0) : appui
            if (g_btn_stable_state == 0) {
                if (!g_run_active) {
                    start_run();
                } else {
                    stop_run();
                }
            }
        }
    }
}

// clignotement LED pendant le RUN
static void handle_led(int64_t now_us)
{
    if (!g_run_active) {
        led_off();
        return;
    }

    int64_t delta_ms = (now_us - g_last_led_toggle_us) / 1000;
    if (delta_ms >= LED_BLINK_MS) {
        g_last_led_toggle_us = now_us;
        led_toggle();
    }
}

// ==== Acquisition + log CSV ====

static void sample_and_log(int64_t now_us)
{
    if (!g_run_active || !g_run_file) return;

    int64_t elapsed_ms = (now_us - g_run_start_us) / 1000;
    if (elapsed_ms < 0) elapsed_ms = 0;
    uint32_t t_ms = (uint32_t)elapsed_ms;

    // 4 positions de MUX -> 8 capteurs (1..4 droite, 5..8 gauche)
    for (uint8_t ch = 0; ch < 4; ++ch) {
        mux_select(ch);
        vTaskDelay(pdMS_TO_TICKS(MUX_SETTLE_MS));

        int mvB = 0, mvA = 0;
        esp_err_t errA;
        read_fsr_pair(&mvB, &mvA, &errA);

        float vB = mvB / 1000.0f;
        float vA = mvA / 1000.0f;

        uint8_t capteurB = (uint8_t)(ch + 1);  // 1..4 main droite
        uint8_t capteurA = (uint8_t)(ch + 5);  // 5..8 main gauche

        // Capteurs main droite (FSR_B)
        fprintf(g_run_file, "%d,%lu,%u,%.4f\n",
                g_run_id,
                (unsigned long)t_ms,
                (unsigned int)capteurB,
                vB);

        // Capteurs main gauche (FSR_A)
        fprintf(g_run_file, "%d,%lu,%u,%.4f\n",
                g_run_id,
                (unsigned long)t_ms,
                (unsigned int)capteurA,
                vA);

        ESP_LOGI(TAG,
                 "RUN=%d t=%lums MUX=%u -> C%u=%.3fV (droite), C%u=%.3fV (gauche, err=%s)",
                 g_run_id,
                 (unsigned long)t_ms,
                 ch,
                 capteurB, vB,
                 capteurA, vA,
                 esp_err_to_name(errA));
    }

    if (++g_samples_since_flush >= 5) {
        fflush(g_run_file);
        g_samples_since_flush = 0;
    }
}

// ==== app_main ====

void app_main(void)
{
    // Désactive complètement le Task Watchdog (évite les messages DEADC0DE)
    esp_task_wdt_deinit();

    ESP_LOGI(TAG, "Boot SMART_BIKE_RUN (btn+LED+ADC+SD, 100ms)");

    gpio_init_all();
    adc_init_all();

    // Tentative SD au boot (si carte absente, on réessaiera lors du 1er RUN)
    if (sdcard_init() != ESP_OK) {
        ESP_LOGW(TAG, "SD non disponible au boot, on réessaiera plus tard.");
    }

    ESP_LOGI(TAG, "Prêt : appuie sur le bouton pour démarrer un RUN.");

    while (1) {
        int64_t now_us = esp_timer_get_time();

        handle_button(now_us);
        handle_led(now_us);

        if (g_run_active) {
            int64_t delta_ms = (now_us - g_last_sample_us) / 1000;
            if (delta_ms >= SAMPLE_PERIOD_MS) {
                g_last_sample_us = now_us;
                sample_and_log(now_us);
            }
        }

        // Laisse respirer FreeRTOS
        vTaskDelay(pdMS_TO_TICKS(10));
    }
}
