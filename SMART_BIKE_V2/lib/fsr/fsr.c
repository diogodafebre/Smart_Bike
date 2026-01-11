#ifndef LIB_FSR_FSR_C
#define LIB_FSR_FSR_C

#include "fsr.h"

#include <sd.h>
#include <stdio.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/unistd.h>

#include "driver/gpio.h"
#include "driver/i2c.h"
#include "driver/sdmmc_host.h"
#include "driver/spi_master.h"
#include "esp_adc/adc_oneshot.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "esp_vfs_fat.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "sdmmc_cmd.h"

adc_oneshot_unit_handle_t adc1_handle;
adc_oneshot_unit_handle_t adc2_handle;
fsr_values_t g_fsr_calibration_values;

esp_err_t fsr_init(void) {
    adc_oneshot_unit_init_cfg_t init_config1 = {
        .unit_id = ADC_UNIT_1,
        .ulp_mode = ADC_ULP_MODE_DISABLE,
    };
    ESP_ERROR_CHECK(adc_oneshot_new_unit(&init_config1, &adc1_handle));

    adc_oneshot_unit_init_cfg_t init_config2 = {
        .unit_id = ADC_UNIT_2,
        .ulp_mode = ADC_ULP_MODE_DISABLE,
    };
    ESP_ERROR_CHECK(adc_oneshot_new_unit(&init_config2, &adc2_handle));

    adc_oneshot_chan_cfg_t config = {
        .bitwidth = ADC_BITWIDTH_DEFAULT,
        .atten = ADC_ATTEN_DB_12,
    };

    ESP_ERROR_CHECK(adc_oneshot_config_channel(adc1_handle, ADC1_CHAN0, &config));
    ESP_ERROR_CHECK(adc_oneshot_config_channel(adc2_handle, ADC2_CHAN0, &config));

    // Set GPIOs for FSR selection
    gpio_config_t io_conf = {
        .intr_type = GPIO_INTR_DISABLE,
        .mode = GPIO_MODE_OUTPUT,
        .pin_bit_mask = (1ULL << FSR_SEL_A_GPIO) | (1ULL << FSR_SEL_B_GPIO),
        .pull_down_en = GPIO_PULLDOWN_DISABLE,
        .pull_up_en = GPIO_PULLUP_DISABLE,
    };
    ESP_ERROR_CHECK(gpio_config(&io_conf));

    return ESP_OK;
}

esp_err_t fsr_read(fsr_values_t* values) {
    for (int i = 0; i < FSR_COUNT; i++) {
        ESP_ERROR_CHECK(gpio_set_level(FSR_SEL_A_GPIO, (i >> 0) & 0x01));
        ESP_ERROR_CHECK(gpio_set_level(FSR_SEL_B_GPIO, (i >> 1) & 0x01));
        ESP_ERROR_CHECK(adc_oneshot_read(adc1_handle, ADC1_CHAN0, &values->fsr_b_values[i]));
        ESP_ERROR_CHECK(adc_oneshot_read(adc2_handle, ADC2_CHAN0, &values->fsr_a_values[i]));
    }
    return ESP_OK;
}

esp_err_t fsr_read_calibrated(fsr_values_t* values) {
    // uint8_t nbr_echantillons = 10;
    // memset(values, 0, sizeof(fsr_values_t));
    // for (int n = 0; n < nbr_echantillons; n++) {
    //     for (int i = 0; i < FSR_COUNT; i++) {
    //         ESP_ERROR_CHECK(gpio_set_level(FSR_SEL_A_GPIO, (i >> 0) & 0x01));
    //         ESP_ERROR_CHECK(gpio_set_level(FSR_SEL_B_GPIO, (i >> 1) & 0x01));
    //         int raw_b, raw_a;
    //         ESP_ERROR_CHECK(adc_oneshot_read(adc1_handle, ADC1_CHAN0, &raw_b));
    //         ESP_ERROR_CHECK(adc_oneshot_read(adc2_handle, ADC2_CHAN0, &raw_a));
    //         values->fsr_b_values[i] += raw_b;
    //         values->fsr_a_values[i] += raw_a;
    //     }
    // }
    // for (int i = 0; i < FSR_COUNT; i++) {
    //     values->fsr_b_values[i] /= nbr_echantillons;
    //     values->fsr_a_values[i] /= nbr_echantillons;
    //     values->fsr_b_values[i] -= g_fsr_calibration_values.fsr_b_values[i];
    //     values->fsr_a_values[i] -= g_fsr_calibration_values.fsr_a_values[i];
    //     if (values->fsr_b_values[i] < 0) values->fsr_b_values[i] = 0;
    //     if (values->fsr_a_values[i] < 0) values->fsr_a_values[i] = 0;
    // }
    for (int i = 0; i < FSR_COUNT; i++) {
        ESP_ERROR_CHECK(gpio_set_level(FSR_SEL_A_GPIO, (i >> 0) & 0x01));
        ESP_ERROR_CHECK(gpio_set_level(FSR_SEL_B_GPIO, (i >> 1) & 0x01));
        int raw_b, raw_a;
        ESP_ERROR_CHECK(adc_oneshot_read(adc1_handle, ADC1_CHAN0, &raw_b));
        ESP_ERROR_CHECK(adc_oneshot_read(adc2_handle, ADC2_CHAN0, &raw_a));
        values->fsr_b_values[i] = raw_b - g_fsr_calibration_values.fsr_b_values[i];
        values->fsr_a_values[i] = raw_a - g_fsr_calibration_values.fsr_a_values[i];
        if (values->fsr_b_values[i] < 0) values->fsr_b_values[i] = 0;
        if (values->fsr_a_values[i] < 0) values->fsr_a_values[i] = 0;
        // ESP_LOGI("FSR Read Calibrated", "FSR B[%d] Calibrated Value: %d, RAW: %d", i, values->fsr_b_values[i], raw_b);
        // ESP_LOGI("FSR Read Calibrated", "FSR A[%d] Calibrated Value: %d, RAW: %d", i, values->fsr_a_values[i], raw_a);
    }
    return ESP_OK;
}

esp_err_t fsr_calibrate(void) {
    uint8_t nbr_echantillons = 100;
    memset(&g_fsr_calibration_values, 0, sizeof(g_fsr_calibration_values));
    for (int n = 0; n < nbr_echantillons; n++) {
        for (int i = 0; i < FSR_COUNT; i++) {
            ESP_ERROR_CHECK(gpio_set_level(FSR_SEL_A_GPIO, (i >> 0) & 0x01));
            ESP_ERROR_CHECK(gpio_set_level(FSR_SEL_B_GPIO, (i >> 1) & 0x01));
            int raw_b, raw_a;
            ESP_ERROR_CHECK(adc_oneshot_read(adc1_handle, ADC1_CHAN0, &raw_b));
            
            // Try to read ADC2, but handle timeout gracefully (WiFi may block it)
            esp_err_t err = adc_oneshot_read(adc2_handle, ADC2_CHAN0, &raw_a);
            if (err == ESP_ERR_TIMEOUT) {
                ESP_LOGW("FSR", "ADC2 timeout during calibration (WiFi active), using zero offset");
                raw_a = 0; // Use zero offset when WiFi blocks ADC2
            } else {
                ESP_ERROR_CHECK(err);
            }
            
            g_fsr_calibration_values.fsr_b_values[i] += raw_b;
            g_fsr_calibration_values.fsr_a_values[i] += raw_a;
        }
        vTaskDelay(pdMS_TO_TICKS(10));
    }
    for (int i = 0; i < FSR_COUNT; i++) {
        g_fsr_calibration_values.fsr_b_values[i] /= nbr_echantillons;
        g_fsr_calibration_values.fsr_a_values[i] /= nbr_echantillons;
        // ESP_LOGI("FSR Calibration", "FSR B[%d] Calibration Value: %d", i, g_fsr_calibration_values.fsr_b_values[i]);
        // ESP_LOGI("FSR Calibration", "FSR A[%d] Calibration Value: %d", i, g_fsr_calibration_values.fsr_a_values[i]);
    }
    return ESP_OK;
}

#endif  // LIB_FSR_FSR_C