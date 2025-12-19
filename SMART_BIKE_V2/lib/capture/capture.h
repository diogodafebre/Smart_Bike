#ifndef LIB_CAPTURE_CAPTURE_H
#define LIB_CAPTURE_CAPTURE_H

#include <fsr.h>
#include <icm42670.h>
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

#define FREQ_CPT_READ_MS 10
#define OFFSET 7

#define PIN_RUN_SWITCH GPIO_NUM_1
#define PIN_RUN_LED GPIO_NUM_2  // Continous ON when not running, Blinking when running

void cpt_init(void);

void cpt_deinit(void);

// esp_err_t cpt_read_all_data(cpt_data_t* data);

// esp_err_t cpt_read_fsr_data(fsr_values_t* fsr_values);

// esp_err_t cpt_read_icm_data(complimentary_angle_t* angles);

// esp_err_t cpt_write_data_to_sd(const char* path, const cpt_data_t* data);

// esp_err_t cpt_task_icm();

// esp_err_t cpt_task_fsr();

// // Execute every fast possible
// esp_err_t cpt_task_read_all();

// // Execute every FREQ_CPT_READ_MS milliseconds
// esp_err_t cpt_task_write_sd(const char* path);

// // Start the capture task
// // Create files - write headers
// esp_err_t cpt_task_start();

void cpt_stop(void);
void cpt_start(void);
void cpt_start_task(void);

// Accessors for webserver integration
bool cpt_is_running(void);
uint32_t cpt_get_run_id(void);
void cpt_get_latest_voltages(float voltages[8]);
uint64_t cpt_get_time_ms(void);
void cpt_get_latest_angles(float* roll, float* pitch);

// esp_err_t cpt_task();

#endif  // LIB_CAPTURE_CAPTURE_H