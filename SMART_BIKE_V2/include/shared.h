#ifndef SHARED_H
#define SHARED_H

#include <stdbool.h>
#include <stdint.h>

// System states
typedef enum {
    STATE_IDLE,
    STATE_RUNNING,
    STATE_CALIBRATING
} system_state_t;

// Calibration data structure - stores min/max values for each sensor
typedef struct {
    float min_values[8];    // Minimum (idle) values for sensors 1-8
    float max_values[8];    // Maximum (pressed) values for sensors 1-8
    bool is_calibrated;     // Whether calibration has been performed
} calibration_data_t;

// Sensor data structure - 8 sensors (4 per hand)
typedef struct {
    float voltages[8];      // Voltages for sensors 1-8 (in Volts)
    uint32_t timestamp_ms;  // Time since run start (in ms)
    bool valid;             // Data validity flag
} sensor_data_t;

// Global state accessible from both sensor and web modules
extern volatile bool g_run_active;
extern volatile int g_run_id;
extern sensor_data_t g_latest_sensor_data;
extern volatile system_state_t g_system_state;
extern calibration_data_t g_calibration;

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
