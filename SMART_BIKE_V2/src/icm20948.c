#include <stdio.h>
#include <string.h>
#include <math.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "esp_log.h"
#include "esp_err.h"
#include "driver/i2c_master.h"

static const char *TAG = "ICM20948";

// ICM-20948 I2C address
#define ICM20948_ADDR           0x68

// ICM-20948 Registers (Bank 0)
#define ICM20948_REG_ACCEL_XOUT_H  0x2D
#define ICM20948_REG_ACCEL_XOUT_L  0x2E
#define ICM20948_REG_ACCEL_YOUT_H  0x2F
#define ICM20948_REG_ACCEL_YOUT_L  0x30
#define ICM20948_REG_ACCEL_ZOUT_H  0x31
#define ICM20948_REG_ACCEL_ZOUT_L  0x32
#define ICM20948_REG_GYRO_XOUT_H   0x33
#define ICM20948_REG_GYRO_XOUT_L   0x34
#define ICM20948_REG_GYRO_YOUT_H   0x35
#define ICM20948_REG_GYRO_YOUT_L   0x36
#define ICM20948_REG_GYRO_ZOUT_H   0x37
#define ICM20948_REG_GYRO_ZOUT_L   0x38
#define ICM20948_REG_PWR_MGMT_1    0x6B
#define ICM20948_REG_WHO_AM_I      0x00

// I2C configuration
#define I2C_MASTER_SDA_IO          10  // GPIO10 (data)
#define I2C_MASTER_SCL_IO          8   // GPIO8 (clock)
#define I2C_MASTER_FREQ_HZ         400000  // 400kHz

// Global I2C bus handle
static i2c_master_bus_handle_t g_i2c_bus_handle = NULL;
static i2c_master_dev_handle_t g_icm20948_dev_handle = NULL;

// Sensitivity scales
#define ACCEL_SENSITIVITY       16384.0f    // LSB/g for ±2g
#define GYRO_SENSITIVITY        131.0f      // LSB/dps for ±250dps

// ===== ICM-20948 Functions =====

/**
 * Initialize I2C bus and ICM-20948 sensor
 */
esp_err_t icm20948_init(void)
{
    ESP_LOGI(TAG, "Initializing ICM-20948...");

    // Configure I2C master bus
    i2c_master_bus_config_t i2c_mst_config = {
        .clk_source = I2C_CLK_SRC_DEFAULT,
        .i2c_port = I2C_NUM_0,
        .scl_io_num = I2C_MASTER_SCL_IO,
        .sda_io_num = I2C_MASTER_SDA_IO,
        .glitch_ignore_cnt = 7,
        .flags.enable_internal_pullup = true,
    };

    esp_err_t ret = i2c_new_master_bus(&i2c_mst_config, &g_i2c_bus_handle);
    if (ret != ESP_OK) {
        ESP_LOGE(TAG, "Failed to create I2C bus: %s", esp_err_to_name(ret));
        return ret;
    }

    // Configure ICM-20948 device on the bus
    i2c_device_config_t dev_cfg = {
        .dev_addr_length = I2C_ADDR_BIT_LEN_7,
        .device_address = ICM20948_ADDR,
        .scl_speed_hz = I2C_MASTER_FREQ_HZ,
    };

    ret = i2c_master_bus_add_device(g_i2c_bus_handle, &dev_cfg, &g_icm20948_dev_handle);
    if (ret != ESP_OK) {
        ESP_LOGE(TAG, "Failed to add ICM-20948 device to I2C bus: %s", esp_err_to_name(ret));
        return ret;
    }

    // Verify ICM-20948 presence (read WHO_AM_I)
    uint8_t who_am_i;
    ret = i2c_master_transmit_receive(g_icm20948_dev_handle, (uint8_t[]){ICM20948_REG_WHO_AM_I}, 1, &who_am_i, 1, -1);
    if (ret != ESP_OK) {
        ESP_LOGE(TAG, "Failed to communicate with ICM-20948: %s", esp_err_to_name(ret));
        return ret;
    }

    ESP_LOGI(TAG, "ICM-20948 WHO_AM_I: 0x%02X (expected 0xEA)", who_am_i);
    if (who_am_i != 0xEA) {
        ESP_LOGW(TAG, "Unexpected WHO_AM_I value, but continuing...");
    }

    // Wake up ICM-20948 (clear sleep bit in PWR_MGMT_1)
    uint8_t pwr_mgmt[2] = {ICM20948_REG_PWR_MGMT_1, 0x00};
    ret = i2c_master_transmit(g_icm20948_dev_handle, pwr_mgmt, sizeof(pwr_mgmt), -1);
    if (ret != ESP_OK) {
        ESP_LOGE(TAG, "Failed to wake up ICM-20948: %s", esp_err_to_name(ret));
        return ret;
    }

    vTaskDelay(pdMS_TO_TICKS(100));  // Wait for sensor to stabilize

    ESP_LOGI(TAG, "ICM-20948 initialized successfully");
    return ESP_OK;
}

/**
 * Read raw data from a 16-bit register (2 bytes: high, low)
 */
static int16_t read_int16_register(uint8_t reg_high)
{
    uint8_t data[2] = {0};
    esp_err_t ret = i2c_master_transmit_receive(g_icm20948_dev_handle, &reg_high, 1, data, 2, -1);
    if (ret != ESP_OK) {
        ESP_LOGE(TAG, "Failed to read register 0x%02X: %s", reg_high, esp_err_to_name(ret));
        return 0;
    }
    return (int16_t)((data[0] << 8) | data[1]);
}

/**
 * Read accelerometer and gyroscope data
 * 
 * @param accel_x Accelerometer X-axis (m/s²)
 * @param accel_y Accelerometer Y-axis (m/s²)
 * @param accel_z Accelerometer Z-axis (m/s²)
 * @param gyro_x Gyroscope X-axis (degrees/sec)
 * @param gyro_y Gyroscope Y-axis (degrees/sec)
 * @param gyro_z Gyroscope Z-axis (degrees/sec)
 */
esp_err_t icm20948_read_data(float *accel_x, float *accel_y, float *accel_z,
                             float *gyro_x, float *gyro_y, float *gyro_z)
{
    if (!g_icm20948_dev_handle) {
        ESP_LOGE(TAG, "ICM-20948 not initialized");
        return ESP_ERR_INVALID_STATE;
    }

    // Read accelerometer
    int16_t accel_raw_x = read_int16_register(ICM20948_REG_ACCEL_XOUT_H);
    int16_t accel_raw_y = read_int16_register(ICM20948_REG_ACCEL_YOUT_H);
    int16_t accel_raw_z = read_int16_register(ICM20948_REG_ACCEL_ZOUT_H);

    // Read gyroscope
    int16_t gyro_raw_x = read_int16_register(ICM20948_REG_GYRO_XOUT_H);
    int16_t gyro_raw_y = read_int16_register(ICM20948_REG_GYRO_YOUT_H);
    int16_t gyro_raw_z = read_int16_register(ICM20948_REG_GYRO_ZOUT_H);

    // Convert raw to physical units
    // Accelerometer: m/s² (1g = 9.81 m/s²)
    *accel_x = (float)accel_raw_x / ACCEL_SENSITIVITY * 9.81f;
    *accel_y = (float)accel_raw_y / ACCEL_SENSITIVITY * 9.81f;
    *accel_z = (float)accel_raw_z / ACCEL_SENSITIVITY * 9.81f;

    // Gyroscope: degrees/sec
    *gyro_x = (float)gyro_raw_x / GYRO_SENSITIVITY;
    *gyro_y = (float)gyro_raw_y / GYRO_SENSITIVITY;
    *gyro_z = (float)gyro_raw_z / GYRO_SENSITIVITY;

    return ESP_OK;
}

/**
 * Deinitialize ICM-20948
 */
esp_err_t icm20948_deinit(void)
{
    if (g_icm20948_dev_handle) {
        i2c_master_bus_rm_device(g_icm20948_dev_handle);
        g_icm20948_dev_handle = NULL;
    }
    if (g_i2c_bus_handle) {
        i2c_del_master_bus(g_i2c_bus_handle);
        g_i2c_bus_handle = NULL;
    }
    return ESP_OK;
}
