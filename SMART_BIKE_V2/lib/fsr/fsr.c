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
    for (int i = 0; i < FSR_COUNT; i++) {
        ESP_ERROR_CHECK(gpio_set_level(FSR_SEL_A_GPIO, (i >> 0) & 0x01));
        ESP_ERROR_CHECK(gpio_set_level(FSR_SEL_B_GPIO, (i >> 1) & 0x01));
        int raw_b, raw_a;
        ESP_ERROR_CHECK(adc_oneshot_read(adc1_handle, ADC1_CHAN0, &raw_b));
        ESP_ERROR_CHECK(adc_oneshot_read(adc2_handle, ADC2_CHAN0, &raw_a));
        values->fsr_b_values[i] = raw_b - g_fsr_calibration_values.fsr_b_values[i];
        values->fsr_a_values[i] = raw_a - g_fsr_calibration_values.fsr_a_values[i];
    }
    return ESP_OK;
}

esp_err_t fsr_calibrate(void) {
    for (int i = 0; i < FSR_COUNT; i++) {
        ESP_ERROR_CHECK(gpio_set_level(FSR_SEL_A_GPIO, (i >> 0) & 0x01));
        ESP_ERROR_CHECK(gpio_set_level(FSR_SEL_B_GPIO, (i >> 1) & 0x01));
        ESP_ERROR_CHECK(adc_oneshot_read(adc1_handle, ADC1_CHAN0, &g_fsr_calibration_values.fsr_b_values[i]));
        ESP_ERROR_CHECK(adc_oneshot_read(adc2_handle, ADC2_CHAN0, &g_fsr_calibration_values.fsr_a_values[i]));
    }
    return ESP_OK;
}

#endif  // LIB_FSR_FSR_C