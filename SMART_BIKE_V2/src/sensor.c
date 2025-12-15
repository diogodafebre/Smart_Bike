#include <stdio.h>
#include <string.h>
#include <sys/stat.h>

#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

#include "esp_system.h"
#include "esp_log.h"
#include "esp_err.h"

#include "driver/gpio.h"
#include "driver/spi_master.h"
#include "driver/adc.h"          // ADC1 + ADC2 legacy (comme dans tes exemples qui marchent)

#include "esp_vfs_fat.h"
#include "sdmmc_cmd.h"
#include "esp_timer.h"
#include "esp_task_wdt.h"        // To disable Task Watchdog
#include "shared.h"               // Shared data structures
#include "icm20948.h"             // ICM-20948 gyroscope/accelerometer

static const char *TAG = "SMART_BIKE_RUN";

// === Pin Mapping ===
// LED_RUN     -> GPIO2 (active HIGH)
// BTN_RUN     -> GPIO1 (button to GND, internal pull-up)
// FSR_B (right) -> ADC1_CH0 / GPIO0
// FSR_A (left) -> ADC2_CH0 / GPIO5
// MUX S1      -> GPIO3
// MUX S0      -> GPIO4
// SD SPI      : CS=6, MOSI=7, SCK=8, MISO=9

#define PIN_LED_RUN    2
#define PIN_BTN_RUN    1

#define PIN_MUX_S1     3
#define PIN_MUX_S0     4

#define PIN_SD_CS      6
#define PIN_SD_MOSI    7
#define PIN_SD_SCK     8
#define PIN_SD_MISO    9

// ADC channels
#define ADC1_CH_FSR_B  ADC1_CHANNEL_0   // GPIO0
#define ADC2_CH_FSR_A  ADC2_CHANNEL_0   // GPIO5

// Parameters
#define SAMPLE_PERIOD_MS   50   // 50 ms between acquisitions
#define MUX_SETTLE_MS        4   // MUX settling time
#define LED_BLINK_MS       200   // LED blink period (200ms for visible blinking)
#define LED_CALIB_BLINK_MS 500   // LED blink period during calibration (faster)
#define BTN_DEBOUNCE_MS     50   // Button debounce time
#define BTN_LONG_PRESS_MS 1000   // Long press threshold for calibration mode
#define VREF_MV           3300   // approx 3.3 V

// Macros LED (active HIGH)
static uint8_t g_led_state = 0;  // Track LED state manually

static inline void led_on(void)  { 
    g_led_state = 1; 
    gpio_set_level(PIN_LED_RUN, 1); 
}
static inline void led_off(void) { 
    g_led_state = 0; 
    gpio_set_level(PIN_LED_RUN, 0); 
}
static inline void led_toggle(void)
{
    g_led_state = !g_led_state;
    gpio_set_level(PIN_LED_RUN, g_led_state);
}

// État global RUN (exported via shared.h)
volatile bool   g_run_active          = false;
volatile int    g_run_id              = 0;
static FILE    *g_run_file            = NULL;
static int      g_samples_since_flush = 0;

// System state (exported via shared.h)
volatile system_state_t g_system_state = STATE_IDLE;

// Calibration data (exported via shared.h)
calibration_data_t g_calibration = {
    .is_calibrated = false
};

// Latest sensor data (exported via shared.h)
sensor_data_t g_latest_sensor_data = {0};

// SD
static bool          g_sd_ready = false;
static sdmmc_card_t *g_sd_card  = NULL;

// Timing
static int64_t g_run_start_us         = 0;
static int64_t g_last_sample_us       = 0;
static int64_t g_last_calib_sample_us = 0;
static int64_t g_last_led_toggle_us   = 0;

// Button
static int     g_btn_stable_state   = 1;    // pull-up -> idle = HIGH
static int64_t g_btn_press_start_us = 0;    // When button was pressed
static bool    g_btn_long_press_handled = false;

// ==== Util GPIO / MUX ====

static void mux_select(uint8_t ch)
{
    // ch = 0..3
    gpio_set_level(PIN_MUX_S0, (ch & 0x01) ? 1 : 0);
    gpio_set_level(PIN_MUX_S1, (ch & 0x02) ? 1 : 0);
}

static void gpio_init_all(void)
{
    // LED + MUX as outputs
    gpio_config_t out_conf = {
        .pin_bit_mask = (1ULL << PIN_LED_RUN) |
                        (1ULL << PIN_MUX_S0) |
                        (1ULL << PIN_MUX_S1),
        .mode = GPIO_MODE_OUTPUT,
        .pull_up_en = GPIO_PULLUP_DISABLE,
        .pull_down_en = GPIO_PULLDOWN_DISABLE,
        .intr_type = GPIO_INTR_DISABLE
    };
    gpio_config(&out_conf);

    // Button as input with pull-up
    gpio_config_t btn_conf = {
        .pin_bit_mask = (1ULL << PIN_BTN_RUN),
        .mode = GPIO_MODE_INPUT,
        .pull_up_en = GPIO_PULLUP_ENABLE,
        .pull_down_en = GPIO_PULLDOWN_DISABLE,
        .intr_type = GPIO_INTR_DISABLE
    };
    gpio_config(&btn_conf);

    led_off();
    mux_select(0);

    ESP_LOGI(TAG, "GPIO init OK");
}

// ==== ADC ====

static void adc_init_all(void)
{
    // ADC1: FSR_B (GPIO0)
    adc1_config_width(ADC_WIDTH_BIT_12);
    adc1_config_channel_atten(ADC1_CH_FSR_B, ADC_ATTEN_DB_11);  // ~0..3.3V

    // ADC2: FSR_A (GPIO5)
    esp_err_t err = adc2_config_channel_atten(ADC2_CH_FSR_A, ADC_ATTEN_DB_11);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "adc2_config_channel_atten failed: %s", esp_err_to_name(err));
    } else {
        ESP_LOGI(TAG, "ADC2 channel config OK");
    }

    ESP_LOGI(TAG, "ADC init OK (ADC1:GPIO0, ADC2:GPIO5)");
}

// Read FSR_B (ADC1) + FSR_A (ADC2) for a given MUX position
static void read_fsr_pair(int *mv_b, int *mv_a, esp_err_t *err_a)
{
    // FSR_B (ADC1)
    int raw_b = adc1_get_raw(ADC1_CH_FSR_B);
    *mv_b = (raw_b * VREF_MV) / 4095;

    // FSR_A (ADC2)
    int raw_a = 0;
    *err_a = adc2_get_raw(ADC2_CH_FSR_A, ADC_WIDTH_BIT_12, &raw_a);
    if (*err_a == ESP_OK) {
        *mv_a = (raw_a * VREF_MV) / 4095;
    } else {
        *mv_a = 0;
    }
}

// ==== SD ====

static esp_err_t sdcard_init(void)
{
    esp_err_t ret;

    ESP_LOGI(TAG, "Init SD (SPI2)…");

    spi_bus_config_t bus_cfg = {
        .mosi_io_num = PIN_SD_MOSI,
        .miso_io_num = PIN_SD_MISO,
        .sclk_io_num = PIN_SD_SCK,
        .quadwp_io_num = -1,
        .quadhd_io_num = -1,
        .max_transfer_sz = 4000,
    };
    ret = spi_bus_initialize(SPI2_HOST, &bus_cfg, SDSPI_DEFAULT_DMA);
    if (ret != ESP_OK && ret != ESP_ERR_INVALID_STATE) {
        ESP_LOGE(TAG, "spi_bus_initialize failed: %s", esp_err_to_name(ret));
        return ret;
    }

    sdmmc_host_t host = SDSPI_HOST_DEFAULT();
    host.slot = SPI2_HOST;

    sdspi_device_config_t slot_config = SDSPI_DEVICE_CONFIG_DEFAULT();
    slot_config.gpio_cs = PIN_SD_CS;
    slot_config.host_id = host.slot;

    esp_vfs_fat_sdmmc_mount_config_t mount_config = {
        .format_if_mount_failed = false,
        .max_files = 8,
        .allocation_unit_size = 16 * 1024,
    };

    ret = esp_vfs_fat_sdspi_mount("/sdcard", &host, &slot_config,
                                  &mount_config, &g_sd_card);
    if (ret != ESP_OK) {
        ESP_LOGE(TAG, "esp_vfs_fat_sdspi_mount failed: %s", esp_err_to_name(ret));
        return ret;
    }

    sdmmc_card_print_info(stdout, g_sd_card);
    ESP_LOGI(TAG, "SD mounted on /sdcard");
    g_sd_ready = true;
    return ESP_OK;
}

// Find next available RUNX.CSV index
static int find_next_run_index(void)
{
    int idx = 1;
    char path[64];
    struct stat st;
    while (1) {
        snprintf(path, sizeof(path), "/sdcard/RUN%d.CSV", idx);
        if (stat(path, &st) != 0) {
            return idx;
        }
        ++idx;
    }
}

// ==== Calibration Functions ====

static void start_calibration(void)
{
    ESP_LOGI(TAG, "=== ENTERING CALIBRATION MODE ===");
    ESP_LOGI(TAG, "Instructions:");
    ESP_LOGI(TAG, "1. Release all sensors (idle position)");
    ESP_LOGI(TAG, "2. Press all sensors to maximum");
    ESP_LOGI(TAG, "3. Press button for 1s to save calibration");
    
    g_system_state = STATE_CALIBRATING;
    
    // Initialize min to high values and max to low values
    for (int i = 0; i < 8; i++) {
        g_calibration.min_values[i] = 3.3f;  // Start high
        g_calibration.max_values[i] = 0.0f;  // Start low
    }
    
    // Initialize timing and LED
    int64_t now_us = esp_timer_get_time();
    g_last_led_toggle_us = now_us;
    g_last_calib_sample_us = now_us;
    led_on();
    
    ESP_LOGI(TAG, "Calibration LED should blink every %dms", LED_CALIB_BLINK_MS);
}

static void stop_calibration(void)
{
    ESP_LOGI(TAG, "=== CALIBRATION COMPLETE ===");
    
    // Display calibration results
    for (int i = 0; i < 8; i++) {
        ESP_LOGI(TAG, "Sensor %d: MIN=%.3fV, MAX=%.3fV", 
                 i+1, 
                 g_calibration.min_values[i], 
                 g_calibration.max_values[i]);
    }
    
    g_calibration.is_calibrated = true;
    g_system_state = STATE_IDLE;
    led_off();
}

// Apply calibration to raw voltage reading
static float apply_calibration(uint8_t sensor_idx, float raw_voltage)
{
    if (!g_calibration.is_calibrated) {
        return raw_voltage;  // No calibration, return raw value
    }
    
    float min_val = g_calibration.min_values[sensor_idx];
    float max_val = g_calibration.max_values[sensor_idx];
    
    // Avoid division by zero
    if (max_val - min_val < 0.01f) {
        return 0.0f;
    }
    
    // Scale from [min_val, max_val] to [0, 3.3V]
    float calibrated = ((raw_voltage - min_val) / (max_val - min_val)) * 3.3f;
    
    // Clamp to valid range
    if (calibrated < 0.0f) calibrated = 0.0f;
    if (calibrated > 3.3f) calibrated = 3.3f;
    
    return calibrated;
}

// Update calibration min/max during calibration mode
static void update_calibration(uint8_t sensor_idx, float voltage)
{
    if (voltage < g_calibration.min_values[sensor_idx]) {
        g_calibration.min_values[sensor_idx] = voltage;
    }
    if (voltage > g_calibration.max_values[sensor_idx]) {
        g_calibration.max_values[sensor_idx] = voltage;
    }
}

// ==== RUN start/stop ====

static void stop_run(void);

static void start_run(void)
{
    if (!g_sd_ready) {
        if (sdcard_init() != ESP_OK) {
            ESP_LOGW(TAG, "SD failed, starting in MONITOR mode only (no recording)");
            g_run_file = NULL;
            g_run_id = 0;
            // Continue without SD card
        }
    }

    if (g_sd_ready) {
        g_run_id = find_next_run_index();
        char path[64];
        snprintf(path, sizeof(path), "/sdcard/RUN%d.CSV", g_run_id);

        ESP_LOGI(TAG, "Start RUN %d -> %s", g_run_id, path);

        g_run_file = fopen(path, "w");
        if (!g_run_file) {
            ESP_LOGE(TAG, "fopen(%s) failed", path);
            g_run_active = false;
            return;
        }

        // Header CSV with ICM-20948 data (accel + gyro)
        fprintf(g_run_file, "run,time_run_ms,capteur,value_V,accel_x_ms2,accel_y_ms2,accel_z_ms2,gyro_x_dps,gyro_y_dps,gyro_z_dps\n");
        fflush(g_run_file);
        g_samples_since_flush = 0;
        ESP_LOGI(TAG, "RUN %d started (SD recording)", g_run_id);
    } else {
        ESP_LOGI(TAG, "MONITOR mode started (serial display only)");
    }

    int64_t now_us = esp_timer_get_time();
    g_run_start_us       = now_us;
    g_last_sample_us     = now_us;
    g_last_led_toggle_us = now_us;
    led_on();

    g_run_active = true;
    g_system_state = STATE_RUNNING;
}

static void stop_run(void)
{
    if (g_run_active) {
        ESP_LOGI(TAG, "Stop RUN %d", g_run_id);
        if (g_run_file) {
            fflush(g_run_file);
            fclose(g_run_file);
            g_run_file = NULL;
        }
    }
    g_run_active = false;
    g_system_state = STATE_IDLE;
    
    // Clear sensor data to prevent webpage from showing zeros
    memset(&g_latest_sensor_data, 0, sizeof(sensor_data_t));
    g_latest_sensor_data.valid = false;
    
    led_off();
}

// ==== Button + LED ====

// Button handling with short/long press detection
static void handle_button(int64_t now_us)
{
    static int      last_reading = 1;
    static int64_t  last_change_us = 0;

    int reading = gpio_get_level(PIN_BTN_RUN);

    if (reading != last_reading) {
        last_change_us = now_us;  // raw change
        last_reading   = reading;
    }

    int64_t delta_ms = (now_us - last_change_us) / 1000;
    if (delta_ms >= BTN_DEBOUNCE_MS) {
        if (reading != g_btn_stable_state) {
            g_btn_stable_state = reading;

            // Falling edge (1 -> 0): button pressed
            if (g_btn_stable_state == 0) {
                g_btn_press_start_us = now_us;
                g_btn_long_press_handled = false;
            }
            // Rising edge (0 -> 1): button released
            else {
                int64_t press_duration_ms = (now_us - g_btn_press_start_us) / 1000;
                
                // Only handle short press if long press wasn't already handled
                if (!g_btn_long_press_handled && press_duration_ms < BTN_LONG_PRESS_MS) {
                    // Short press: toggle RUN mode (only when not calibrating)
                    if (g_system_state != STATE_CALIBRATING) {
                        if (!g_run_active) {
                            start_run();
                        } else {
                            stop_run();
                        }
                    }
                }
            }
        }
    }
    
    // Check for long press while button is held down
    if (g_btn_stable_state == 0 && !g_btn_long_press_handled) {
        int64_t press_duration_ms = (now_us - g_btn_press_start_us) / 1000;
        
        if (press_duration_ms >= BTN_LONG_PRESS_MS) {
            g_btn_long_press_handled = true;
            
            // Long press: toggle calibration mode
            if (g_system_state == STATE_CALIBRATING) {
                stop_calibration();
            } else if (g_system_state == STATE_IDLE) {
                start_calibration();
            }
            // Ignore long press during RUN mode
        }
    }
}

// LED control during different states
static void handle_led(int64_t now_us)
{
    if (g_system_state == STATE_IDLE) {
        led_off();
        return;
    }
    
    // During RUN: LED stays on (solid)
    if (g_system_state == STATE_RUNNING) {
        if (g_led_state == 0) {
            led_on();
        }
        return;
    }

    // During CALIBRATION: LED blinks
    if (g_system_state == STATE_CALIBRATING) {
        int64_t delta_ms = (now_us - g_last_led_toggle_us) / 1000;
        if (delta_ms >= LED_CALIB_BLINK_MS) {
            g_last_led_toggle_us = now_us;
            led_toggle();
        }
    }
}

// ==== Acquisition + CSV logging ====

static void sample_and_log(int64_t now_us)
{
    if (!g_run_active) return;

    int64_t elapsed_ms = (now_us - g_run_start_us) / 1000;
    if (elapsed_ms < 0) elapsed_ms = 0;
    uint32_t t_ms = (uint32_t)elapsed_ms;

    // Read ICM-20948 (gyroscope + accelerometer)
    float accel_x = 0.0f, accel_y = 0.0f, accel_z = 0.0f;
    float gyro_x = 0.0f, gyro_y = 0.0f, gyro_z = 0.0f;
    
    esp_err_t imu_err = icm20948_read_data(&accel_x, &accel_y, &accel_z,
                                           &gyro_x, &gyro_y, &gyro_z);
    if (imu_err != ESP_OK) {
        ESP_LOGW(TAG, "Failed to read ICM-20948: %s", esp_err_to_name(imu_err));
    }

    // Store IMU data in global shared structure
    g_latest_sensor_data.accel_x = accel_x;
    g_latest_sensor_data.accel_y = accel_y;
    g_latest_sensor_data.accel_z = accel_z;
    g_latest_sensor_data.gyro_x = gyro_x;
    g_latest_sensor_data.gyro_y = gyro_y;
    g_latest_sensor_data.gyro_z = gyro_z;

    // 4 MUX positions -> 8 sensors (1..4 right, 5..8 left)
    for (uint8_t ch = 0; ch < 4; ++ch) {
        mux_select(ch);
        vTaskDelay(pdMS_TO_TICKS(MUX_SETTLE_MS));

        int mvB = 0, mvA = 0;
        esp_err_t errA;
        read_fsr_pair(&mvB, &mvA, &errA);

        float vB_raw = mvB / 1000.0f;
        float vA_raw = mvA / 1000.0f;

        uint8_t capteurB = (uint8_t)(ch + 1);  // 1..4 right hand
        uint8_t capteurA = (uint8_t)(ch + 5);  // 5..8 left hand

        // Apply calibration
        float vB = apply_calibration(capteurB - 1, vB_raw);
        float vA = apply_calibration(capteurA - 1, vA_raw);

        // Store calibrated values in global shared data structure
        g_latest_sensor_data.voltages[capteurB - 1] = vB;  // index 0-3
        g_latest_sensor_data.voltages[capteurA - 1] = vA;  // index 4-7

        // Write to SD only if file is open
        if (g_run_file) {
            // Right hand sensors (FSR_B)
            fprintf(g_run_file, "%d,%lu,%u,%.4f,%.3f,%.3f,%.3f,%.2f,%.2f,%.2f\n",
                    g_run_id,
                    (unsigned long)t_ms,
                    (unsigned int)capteurB,
                    vB,
                    accel_x, accel_y, accel_z,
                    gyro_x, gyro_y, gyro_z);

            // Capteurs main gauche (FSR_A)
            fprintf(g_run_file, "%d,%lu,%u,%.4f,%.3f,%.3f,%.3f,%.2f,%.2f,%.2f\n",
                    g_run_id,
                    (unsigned long)t_ms,
                    (unsigned int)capteurA,
                    vA,
                    accel_x, accel_y, accel_z,
                    gyro_x, gyro_y, gyro_z);
        }

        // Serial display always active (with or without SD)
        ESP_LOGI(TAG,
                 "RUN=%d t=%lums MUX=%u -> C%u=%.3fV, C%u=%.3fV | Accel(m/s²): X=%.2f Y=%.2f Z=%.2f | Gyro(dps): X=%.1f Y=%.1f Z=%.1f",
                 g_run_id,
                 (unsigned long)t_ms,
                 ch,
                 capteurB, vB,
                 capteurA, vA,
                 accel_x, accel_y, accel_z,
                 gyro_x, gyro_y, gyro_z);
    }

    // Update timestamp and mark data as valid
    g_latest_sensor_data.timestamp_ms = t_ms;
    g_latest_sensor_data.valid = true;

    if (g_run_file && ++g_samples_since_flush >= 5) {
        fflush(g_run_file);
        g_samples_since_flush = 0;
    }
}

// Calibration sampling (no logging, just update min/max)
static void sample_for_calibration(void)
{
    // 4 MUX positions -> 8 sensors
    for (uint8_t ch = 0; ch < 4; ++ch) {
        mux_select(ch);
        vTaskDelay(pdMS_TO_TICKS(MUX_SETTLE_MS));

        int mvB = 0, mvA = 0;
        esp_err_t errA;
        read_fsr_pair(&mvB, &mvA, &errA);

        float vB = mvB / 1000.0f;
        float vA = mvA / 1000.0f;

        uint8_t capteurB = (uint8_t)(ch + 1);  // 1..4 right hand
        uint8_t capteurA = (uint8_t)(ch + 5);  // 5..8 left hand

        // Update calibration min/max for both sensors
        update_calibration(capteurB - 1, vB);
        update_calibration(capteurA - 1, vA);

        // Store raw values for display
        g_latest_sensor_data.voltages[capteurB - 1] = vB;
        g_latest_sensor_data.voltages[capteurA - 1] = vA;
    }
    
    g_latest_sensor_data.valid = true;
}

// ==== Sensor Module Functions ====

void sensor_init(void)
{
    ESP_LOGI(TAG, "Initializing sensor module...");

    gpio_init_all();
    adc_init_all();

    // Initialize ICM-20948 (gyroscope + accelerometer)
    if (icm20948_init() != ESP_OK) {
        ESP_LOGW(TAG, "ICM-20948 initialization failed, continuing without IMU");
    }

    // Try SD at boot (if card absent, we'll retry on first RUN)
    if (sdcard_init() != ESP_OK) {
        ESP_LOGW(TAG, "SD not available at boot, will retry later.");
    }

    ESP_LOGI(TAG, "Sensor module ready.");
}

void sensor_task(void *pvParameters)
{
    ESP_LOGI(TAG, "Sensor task started");

    // Initialize sensor data to zero
    memset(&g_latest_sensor_data, 0, sizeof(sensor_data_t));
    g_latest_sensor_data.valid = false;

    while (1) {
        int64_t now_us = esp_timer_get_time();

        handle_button(now_us);
        handle_led(now_us);

        // State machine for different modes
        switch (g_system_state) {
            case STATE_IDLE:
                // Do nothing, just monitor button
                break;
                
            case STATE_RUNNING:
                if (g_run_active) {
                    int64_t delta_ms = (now_us - g_last_sample_us) / 1000;
                    if (delta_ms >= SAMPLE_PERIOD_MS) {
                        g_last_sample_us = now_us;
                        sample_and_log(now_us);
                    }
                }
                break;
                
            case STATE_CALIBRATING:
                // Sample every 100ms to find min/max
                {
                    int64_t delta_ms = (now_us - g_last_calib_sample_us) / 1000;
                    if (delta_ms >= 100) {
                        g_last_calib_sample_us = now_us;
                        sample_for_calibration();
                    }
                }
                break;
        }

        // Let FreeRTOS breathe
        vTaskDelay(pdMS_TO_TICKS(10));
    }
}

void sensor_start_run(void)
{
    if (!g_run_active) {
        start_run();
    }
}

void sensor_stop_run(void)
{
    if (g_run_active) {
        stop_run();
    }
}

bool sensor_is_run_active(void)
{
    return g_run_active;
}

int sensor_get_run_id(void)
{
    return g_run_id;
}
