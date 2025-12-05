#ifndef SHARED_H
#define SHARED_H

#include <stdbool.h>
#include <stdint.h>

// Sensor data structure - 8 sensors (4 per hand) + ICM-20948 (gyro + accel)
typedef struct {
    float voltages[8];      // Voltages for sensors 1-8 (in Volts)
    float accel_x;          // Accelerometer X-axis (m/s²)
    float accel_y;          // Accelerometer Y-axis (m/s²)
    float accel_z;          // Accelerometer Z-axis (m/s²)
    float gyro_x;           // Gyroscope X-axis (degrees/sec)
    float gyro_y;           // Gyroscope Y-axis (degrees/sec)
    float gyro_z;           // Gyroscope Z-axis (degrees/sec)
    uint32_t timestamp_ms;  // Time since run start (in ms)
    bool valid;             // Data validity flag
} sensor_data_t;

// Global state accessible from both sensor and web modules
extern volatile bool g_run_active;
extern volatile int g_run_id;
extern sensor_data_t g_latest_sensor_data;

// Functions exported from sensor module (main.c)
void sensor_init(void);
void sensor_task(void *pvParameters);
void sensor_start_run(void);
void sensor_stop_run(void);
bool sensor_is_run_active(void);
int sensor_get_run_id(void);

// Functions exported from web module (webserver.c)
void web_init(void);

#endif // SHARED_H
