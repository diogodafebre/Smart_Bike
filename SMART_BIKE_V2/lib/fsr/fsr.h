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

// GPIO 0 correspond au Canal 0 de l'ADC 1
#define ADC1_CHAN0 ADC_CHANNEL_0
// GPIO 5 correspond au Canal 0 de l'ADC 2
#define ADC2_CHAN0 ADC_CHANNEL_0

#define FSR_COUNT 4

extern adc_oneshot_unit_handle_t adc1_handle;
extern adc_oneshot_unit_handle_t adc2_handle;

typedef struct {
    int fsr_a_values[FSR_COUNT];
    int fsr_b_values[FSR_COUNT];
} fsr_values_t;

esp_err_t fsr_init(void);
esp_err_t fsr_read(fsr_values_t* values);

#endif  // LIB_FSR_FSR_H