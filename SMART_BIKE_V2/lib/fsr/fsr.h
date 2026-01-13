#ifndef LIB_FSR_FSR_H
#define LIB_FSR_FSR_H

#include <stdio.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/unistd.h>

#include "driver/gpio.h"
#include "driver/i2c.h"
#include "driver/sdmmc_host.h"
#include "driver/spi_master.h"
#include "esp_adc/adc_oneshot.h"
#include "esp_err.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "esp_vfs_fat.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "sdmmc_cmd.h"

#define ADC1_CHAN0 ADC_CHANNEL_0
#define ADC1_CHAN4 ADC_CHANNEL_4

#define FSR_COUNT 4
#define FSR_SEL_A_GPIO GPIO_NUM_3
#define FSR_SEL_B_GPIO GPIO_NUM_5

extern adc_oneshot_unit_handle_t adc1_handle;

typedef struct {
    int fsr_a_values[FSR_COUNT];
    int fsr_b_values[FSR_COUNT];
} fsr_values_t;

esp_err_t fsr_init(void);
esp_err_t fsr_read(fsr_values_t* values);
esp_err_t fsr_calibrate(void);
esp_err_t fsr_read_calibrated(fsr_values_t* values);

#endif  // LIB_FSR_FSR_H