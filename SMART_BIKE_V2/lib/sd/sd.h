#ifndef LIB_SD_SD_H
#define LIB_SD_SD_H

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

// Define SD card pins
#define PIN_NUM_CS 6
#define PIN_NUM_MOSI 7
#define PIN_NUM_CLK 21
#define PIN_NUM_MISO 9

#define MOUNT_POINT "/sdcard"

esp_err_t sd_write_file(const char* path, char* data);

uint32_t sd_find_next_run_index();

void sdcard_init(void);

void sd_add(char* path, char* data);

void sdcard_test_filesystem();

void sd_deinit();
#endif  // LIB_SD_SD_H