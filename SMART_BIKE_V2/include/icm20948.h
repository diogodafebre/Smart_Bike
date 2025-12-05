#ifndef ICM20948_H
#define ICM20948_H

#include "esp_err.h"

/**
 * Initialize I2C and ICM-20948 sensor
 */
esp_err_t icm20948_init(void);

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
                             float *gyro_x, float *gyro_y, float *gyro_z);

/**
 * Deinitialize ICM-20948
 */
esp_err_t icm20948_deinit(void);

#endif // ICM20948_H
