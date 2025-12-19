
#ifndef LIB_SD_SD_C
#define LIB_SD_SD_C

#include "sd.h"

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

static const char TAG[] = "SD";

const char mount_point[] = MOUNT_POINT;
sdmmc_card_t* card;
sdmmc_host_t host;

esp_err_t sd_write_file(const char* path, char* data) {
    FILE* f = fopen(path, "a");
    if (f == NULL) {
        ESP_LOGE(TAG, "Failed to open file for writing");
        return ESP_FAIL;
    }
    fprintf(f, data);
    fclose(f);
    return ESP_OK;
}

esp_err_t sd_write_file_new(const char* path, char* data) {
    FILE* f = fopen(path, "w");
    if (f == NULL) {
        ESP_LOGE(TAG, "Failed to open file for writing");
        return ESP_FAIL;
    }
    fprintf(f, data);
    fclose(f);
    return ESP_OK;
}

uint32_t sd_find_next_run_index() {
    uint32_t index = 0;
    char path[64];
    struct stat st;

    while (1) {
        snprintf(path, sizeof(path), MOUNT_POINT "/run_%03ld.txt", index);
        if (stat(path, &st) != 0) {
            return index;
        }
        index++;
    }
    return index;
}

void sdcard_init(void) {
    esp_err_t ret;

    // Options for mounting the filesystem.
    // If format_if_mount_failed is set to true, SD card will be partitioned and
    // formatted in case when mounting fails.
    esp_vfs_fat_sdmmc_mount_config_t mount_config = { .format_if_mount_failed = false, .max_files = 5, .allocation_unit_size = 16 * 1024 };

    ESP_LOGI(TAG, "Initializing SD card");
    ESP_LOGI(TAG, "Using SPI peripheral");
    sdmmc_host_t _host = SDSPI_HOST_DEFAULT();
    host = _host;

    spi_bus_config_t bus_cfg = {
        .mosi_io_num = PIN_NUM_MOSI,
        .miso_io_num = PIN_NUM_MISO,
        .sclk_io_num = PIN_NUM_CLK,
        .quadwp_io_num = -1,
        .quadhd_io_num = -1,
        .max_transfer_sz = 4000,
    };

    ret = spi_bus_initialize(host.slot, &bus_cfg, SDSPI_DEFAULT_DMA);
    if (ret != ESP_OK) {
        ESP_LOGE(TAG, "Failed to initialize bus.");
        return;
    }

    sdspi_device_config_t slot_config = SDSPI_DEVICE_CONFIG_DEFAULT();
    slot_config.gpio_cs = PIN_NUM_CS;
    slot_config.host_id = host.slot;

    ESP_LOGI(TAG, "Mounting filesystem");
    ret = esp_vfs_fat_sdspi_mount(mount_point, &host, &slot_config, &mount_config, &card);

    if (ret != ESP_OK) {
        if (ret == ESP_FAIL) {
            ESP_LOGE(TAG, "Failed to mount filesystem. ");
        } else {
            ESP_LOGE(TAG, "Failed to initialize the card (%s). ", esp_err_to_name(ret));
        }
        return;
    }
    ESP_LOGI(TAG, "Filesystem mounted");

    sdmmc_card_print_info(stdout, card);
}

void sd_add(char* path, char* data) {
    FILE* f = fopen(path, "a");
    if (f == NULL) {
        ESP_LOGE(TAG, "Failed to open file for appending");
        return;
    }
    fprintf(f, data);
    fclose(f);
}

void sdcard_test_filesystem() {
    esp_err_t ret;
    const char* file_hello = MOUNT_POINT "/hello.txt";
    char data[64];
    snprintf(data, 64, "%s %s!\n", "Hello", card->cid.name);
    ret = sd_write_file(file_hello, data);
    if (ret != ESP_OK) {
        return;
    }

    const char* file_foo = MOUNT_POINT "/foo.txt";

    // Check if destination file exists before renaming
    struct stat st;
    if (stat(file_foo, &st) == 0) {
        // Delete it if it exists
        unlink(file_foo);
    }

    // Rename original file
    ESP_LOGI(TAG, "Renaming file %s to %s", file_hello, file_foo);
    if (rename(file_hello, file_foo) != 0) {
        ESP_LOGE(TAG, "Rename failed");
        return;
    }

    // Format FATFS
#ifdef CONFIG_EXAMPLE_FORMAT_SD_CARD
    ret = esp_vfs_fat_sdcard_format(mount_point, card);
    if (ret != ESP_OK) {
        ESP_LOGE(TAG, "Failed to format FATFS (%s)", esp_err_to_name(ret));
        return;
    }

    if (stat(file_foo, &st) == 0) {
        ESP_LOGI(TAG, "file still exists");
        return;
    } else {
        ESP_LOGI(TAG, "file doesn't exist, formatting done");
    }
#endif  // CONFIG_EXAMPLE_FORMAT_SD_CARD

    const char* file_nihao = MOUNT_POINT "/nihao.txt";
    memset(data, 0, 64);
    snprintf(data, 64, "%s %s!\n", "Nihao", card->cid.name);
    ret = sd_write_file(file_nihao, data);
    if (ret != ESP_OK) {
        return;
    }
}

void sd_deinit() {
    esp_vfs_fat_sdcard_unmount(mount_point, card);
    ESP_LOGI(TAG, "Card unmounted");
    spi_bus_free(host.slot);
}
#endif  // LIB_SD_SD_C