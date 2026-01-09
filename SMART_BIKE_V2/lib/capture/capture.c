#ifndef LIB_CAPTURE_CAPTURE_C
#define LIB_CAPTURE_CAPTURE_C

#include "capture.h"

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
#include "esp_check.h"
#include "esp_err.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "esp_vfs_fat.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "sdmmc_cmd.h"

static esp_err_t cpt_init_timer(void);
static esp_err_t cpt_task(void);

typedef enum {
    CPT_STATE_IDLE = 0,
    CPT_STATE_STARTING,  // Initialize sensors and prepare file
    CPT_STATE_RUNNING,   // Read sensors -> max frequency
    CPT_STATE_WRITE_SD,  // Write data to SD card -> every FREQ_CPT_READ_MS
    CPT_STATE_STOPPING,
} cpt_state_t;

cpt_state_t cpt_state = CPT_STATE_IDLE;
cpt_state_t cpt_old_state = CPT_STATE_IDLE;

static const char TAG[] = "CPT";
uint64_t cpt_time_ticks = 0;

bool cpt_started = false;
char cpt_file_path[64];
uint32_t cpt_run_id = 0;

typedef struct {
    complimentary_angle_t angles;
    fsr_values_t fsr_values;
} cpt_data_t;
cpt_data_t g_cpt_data;

esp_timer_handle_t timer_handle;

bool initialized = false;
bool running = false;

esp_err_t cpt_pin(void) {
    esp_err_t ret;
    ret = gpio_set_direction(PIN_RUN_LED, GPIO_MODE_OUTPUT);
    ESP_RETURN_ON_ERROR(ret, TAG, "GPIO set direction failed");
    ret = gpio_set_direction(PIN_RUN_SWITCH, GPIO_MODE_INPUT);
    ESP_RETURN_ON_ERROR(ret, TAG, "GPIO set direction failed");
    return ESP_OK;
}

void cpt_init(void) {
    ESP_LOGI(TAG, "Capture Init started");
    ESP_LOGI(TAG, "SD Init...");
    sdcard_init();
    ESP_LOGI(TAG, "OK");
    ESP_LOGI(TAG, "ICM Init...");
    i2c_sensor_icm42670_init();
    ESP_LOGI(TAG, "OK");
    ESP_LOGI(TAG, "FSR Init...");
    fsr_init();
    ESP_LOGI(TAG, "OK");
    ESP_LOGI(TAG, "Timer Init...");
    cpt_init_timer();
    ESP_LOGI(TAG, "OK");
    ESP_LOGI(TAG, "Pin Init...");
    cpt_pin();
    ESP_LOGI(TAG, "OK");
    ESP_LOGI(TAG, "Capture Init done");

    initialized = true;
}

void cpt_start_task() {
    if (!initialized) {
        ESP_LOGE(TAG, "Capture not initialized !");
        return;
    }
    if (running) {
        ESP_LOGW(TAG, "Capture already running !");
        return;
    }
    ESP_LOGI(TAG, "Starting Capture task...");
    running = true;
    cpt_task();
}

void IRAM_ATTR timer_callback(void* arg) {
    TaskHandle_t taskToNotify = (TaskHandle_t)arg;

    // Réveille la tâche principale
    BaseType_t xHigherPriorityTaskWoken = pdFALSE;
    vTaskNotifyGiveFromISR(taskToNotify, &xHigherPriorityTaskWoken);

    // Force un changement de contexte si nécessaire (pour revenir direct à la tâche)
    portYIELD_FROM_ISR(xHigherPriorityTaskWoken);
}

static esp_err_t cpt_init_timer(void) {
    esp_timer_create_args_t timer_args = { .callback = &timer_callback, .arg = xTaskGetCurrentTaskHandle(), .name = "us_timer" };
    return esp_timer_create(&timer_args, &timer_handle);
}

void cpt_deinit(void) {
    ESP_LOGI(TAG, "Capture Deinit started");
    sd_deinit();
    ESP_LOGI(TAG, "SD Deinit done");
    ESP_LOGI(TAG, "Capture Deinit done");
}

// esp_err_t cpt_read_all_data(cpt_data_t* data) {
//     esp_err_t ret;

//     ret = i2c_sensor_icm42670_read_angles(&data->angles);
//     ESP_RETURN_ON_ERROR(ret, TAG, "ICM42670 read angles failed");

//     ret = fsr_read_calibrated(&data->fsr_values);
//     ESP_RETURN_ON_ERROR(ret, TAG, "FSR read values failed");

//     return ESP_OK;
// }

// // esp_err_t cpt_read_fsr_data(fsr_values_t* fsr_values) {
// //     esp_err_t ret;

//     ret = fsr_read_calibrated(fsr_values);
//     ESP_RETURN_ON_ERROR(ret, TAG, "FSR read values failed");

//     return ESP_OK;
// }

esp_err_t cpt_read_icm_data(complimentary_angle_t* angles) {
    esp_err_t ret;

    ret = i2c_sensor_icm42670_read_angles(angles);
    ESP_RETURN_ON_ERROR(ret, TAG, "ICM42670 read angles failed");

    return ESP_OK;
}

esp_err_t cpt_write_data_to_sd(const char* path, const cpt_data_t* data) {
    char buffer[256];
    snprintf(
        buffer,
        sizeof(buffer),
        "%llu, %.2f, %.2f, %d, %d, %d, %d, %d, %d, %d, %d\n",
        (cpt_time_ticks / 2),
        data->angles.roll,
        data->angles.pitch,
        data->fsr_values.fsr_b_values[0] * OFFSET,
        data->fsr_values.fsr_b_values[1] * OFFSET,
        data->fsr_values.fsr_b_values[2] * OFFSET,
        data->fsr_values.fsr_b_values[3] * OFFSET,
        data->fsr_values.fsr_a_values[0] * OFFSET,
        data->fsr_values.fsr_a_values[1] * OFFSET,
        data->fsr_values.fsr_a_values[2] * OFFSET,
        data->fsr_values.fsr_a_values[3] * OFFSET);
    ESP_LOGD(TAG, "Writing data to SD: %s", buffer);
    return sd_write_file(path, buffer);
}

esp_err_t cpt_task_icm() {
    esp_err_t ret;
    complimentary_angle_t angles;

    ret = i2c_sensor_icm42670_read_angles(&angles);
    ESP_RETURN_ON_ERROR(ret, TAG, "ICM42670 read angles failed");

    // ESP_LOGI(TAG, "Roll: %.2f Pitch: %.2f", angles.roll, angles.pitch);
    g_cpt_data.angles = angles;

    return ESP_OK;
}

esp_err_t cpt_task_fsr() {
    esp_err_t ret;
    ret = fsr_read_calibrated(&g_cpt_data.fsr_values);
    ESP_RETURN_ON_ERROR(ret, TAG, "FSR read values failed");
    return ESP_OK;
}

// Execute every fast possible
esp_err_t cpt_task_read_all() {
    esp_err_t ret;

    ret = cpt_task_icm();
    ESP_RETURN_ON_ERROR(ret, TAG, "Capture ICM task failed");

    ret = cpt_task_fsr();
    ESP_RETURN_ON_ERROR(ret, TAG, "Capture FSR task failed");

    return ESP_OK;
}

// Execute every FREQ_CPT_READ_MS milliseconds
esp_err_t cpt_task_write_sd(const char* path) {
    esp_err_t ret;

    ret = cpt_write_data_to_sd(path, &g_cpt_data);
    ESP_RETURN_ON_ERROR(ret, TAG, "Write data to SD failed");

    return ESP_OK;
}

// Start the capture task
// Create files - write headers
esp_err_t cpt_task_start() {
    fsr_calibrate();
    cpt_run_id = sd_find_next_run_index();
    snprintf(cpt_file_path, sizeof(cpt_file_path), MOUNT_POINT "/RUN_%03u.csv", (unsigned int)cpt_run_id);
    ESP_LOGI(TAG, "Capture started, writing to file: %s", cpt_file_path);
    const char* header = "Time(ms), Roll(deg), Pitch(deg), FSR_B0, FSR_B1, FSR_B2, FSR_B3, FSR_A0, FSR_A1, FSR_A2, FSR_A3\n";
    extern esp_err_t sd_write_file_new(const char* path, char* data);
    esp_err_t ret = sd_write_file_new(cpt_file_path, (char*)header);
    ESP_RETURN_ON_ERROR(ret, TAG, "Write header to SD failed");
    cpt_time_ticks = 0;
    cpt_started = true;
    return ESP_OK;
}

void cpt_stop(void) {
    cpt_started = false;
}

void cpt_start(void) {
    cpt_started = true;
}

// Accessors for webserver integration
bool cpt_is_running(void) {
    return cpt_started;
}

uint32_t cpt_get_run_id(void) {
    return cpt_run_id;
}

void cpt_get_latest_voltages(float voltages[8]) {
    // FSR values are 12-bit ADC (0-4095), convert to voltage (0-3.3V)
    // Then multiply by 7 for better visualization
    // FSR_B = Right grip sensors 1-4
    // FSR_A = Left grip sensors 5-8
    for (int i = 0; i < 4; i++) {
        voltages[i] = ((g_cpt_data.fsr_values.fsr_b_values[i] * 3.3f) / 4095.0f) * 7.0f;
    }
    for (int i = 0; i < 4; i++) {
        voltages[i + 4] = ((g_cpt_data.fsr_values.fsr_a_values[i] * 3.3f) / 4095.0f) * 7.0f;
    }
}

uint64_t cpt_get_time_ms(void) {
    return cpt_time_ticks / 2;  // Convert ticks to milliseconds
}

void cpt_get_latest_angles(float* roll, float* pitch) {
    if (roll) *roll = g_cpt_data.angles.roll;
    if (pitch) *pitch = g_cpt_data.angles.pitch;
}

esp_err_t cpt_task_once(void) {
    static uint32_t last_tick_time = 0;
    static uint32_t count_led_blink = 0;
    static bool on = false;

    if (gpio_get_level(PIN_RUN_SWITCH) == 0) {
        cpt_started = true;
    } else {
        cpt_started = false;
    }

    if (cpt_started) {
        if (count_led_blink >= 250 / (FREQ_CPT_READ_MS / 2)) {
            on = !on;
            gpio_set_level(PIN_RUN_LED, on);
            count_led_blink = 0;
        } else {
            count_led_blink++;
        }
    } else {
        // LED ON steady
        gpio_set_level(PIN_RUN_LED, 1);
        count_led_blink = 0;
    }

    // transaction state machine
    //ESP_LOGD(TAG, "Capture task once - state: %d", cpt_state);
    switch (cpt_state) {
        case CPT_STATE_IDLE:
            if (cpt_started) cpt_state = CPT_STATE_STARTING;
            break;
        case CPT_STATE_STARTING:
            cpt_state = CPT_STATE_RUNNING;
            break;
        case CPT_STATE_RUNNING:
            if (cpt_started == false)
                cpt_state = CPT_STATE_STOPPING;
            else if (((cpt_time_ticks - last_tick_time) / 2) >= FREQ_CPT_READ_MS) {
                last_tick_time = cpt_time_ticks;
                cpt_state = CPT_STATE_WRITE_SD;
            }
            break;
        case CPT_STATE_WRITE_SD:
            cpt_state = CPT_STATE_RUNNING;
            break;
        case CPT_STATE_STOPPING:
            cpt_state = CPT_STATE_IDLE;
            break;
        default:
            ESP_LOGE(TAG, "Invalid capture state");
            return ESP_ERR_INVALID_STATE;
    }

    if (cpt_state != cpt_old_state) {
        //ESP_LOGI(TAG, "Capture state changed: %d -> %d", cpt_old_state, cpt_state);

        // Entry actions
        switch (cpt_state) {
            case CPT_STATE_IDLE:
                break;
            case CPT_STATE_STARTING:
                ESP_LOGI(TAG, "Capture starting...");
                ESP_RETURN_ON_ERROR(cpt_task_start(), TAG, "Capture start task failed");
                break;
            case CPT_STATE_RUNNING:
                break;
            case CPT_STATE_WRITE_SD:
                //ESP_LOGI(TAG, "Capture writing to SD...");
                ESP_RETURN_ON_ERROR(cpt_task_write_sd(cpt_file_path), TAG, "Capture write SD task failed");
                break;
            case CPT_STATE_STOPPING:
                ESP_LOGI(TAG, "Capture stopping...");
                cpt_started = false;
                break;
            default:
                break;
        }

        cpt_old_state = cpt_state;
    }
    // During actions
    switch (cpt_state) {
        case CPT_STATE_IDLE:
            break;
        case CPT_STATE_STARTING:
            break;
        case CPT_STATE_RUNNING:
            ESP_RETURN_ON_ERROR(cpt_task_read_all(), TAG, "Capture read all task failed");
            break;
        case CPT_STATE_WRITE_SD:
            break;
        case CPT_STATE_STOPPING:
            break;
        default:
            break;
    }
    return ESP_OK;
}

static esp_err_t cpt_task(void) {
    while (1) {
        esp_err_t ret = cpt_task_once();
        ESP_RETURN_ON_ERROR(ret, TAG, "Capture task once failed");
        cpt_time_ticks += 1;
        esp_timer_start_once(timer_handle, 500);
        ulTaskNotifyTake(pdTRUE, portMAX_DELAY);
        // vTaskDelay(pdMS_TO_TICKS(1));
    }
    return ESP_OK;
}

#endif  // LIB_CAPTURE_CAPTURE_C