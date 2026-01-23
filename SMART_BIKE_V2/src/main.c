// Integrated main entry point for Smart Bike
// Coordinates capture library (sensors, IMU, SD) and web server module

#include <capture.h>

#include "esp_log.h"
#include "esp_task_wdt.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

// Forward declaration for web_init
void web_init(void);

static const char* TAG = "SMART_BIKE_MAIN";

void app_main(void) {
    // Completely disable Task Watchdog (avoids DEADC0DE messages)
    esp_task_wdt_deinit();

    // TOTO REMOVE : Juste a delay to see logs clearly at startup
    vTaskDelay(pdMS_TO_TICKS(5000));

    ESP_LOGI(TAG, "=== SMART BIKE V2 ===");
    ESP_LOGI(TAG, "Initializing integrated system...");

    // Initialize capture system FIRST (FSR sensors, IMU, SD card)
    ESP_LOGI(TAG, "Initializing capture system...");
    cpt_init();

    // Then initialize web server module (WiFi + HTTP server)
    // This order ensures SD card is mounted before webserver might try to access it
    web_init();

    // Start capture task (handles sensor reading, SD writing, button, LED)
    ESP_LOGI(TAG, "Starting capture task...");
    cpt_start_task();

    ESP_LOGI(TAG, "System ready!");
    ESP_LOGI(TAG, "Connect to WiFi AP 'SmartBike' and browse to http://192.168.4.1/");
    ESP_LOGI(TAG, "Press button (GPIO1) to start/stop recording");

    // Main task can just idle (all work is done in other tasks)
    while (1) {
        vTaskDelay(pdMS_TO_TICKS(1000));
    }
}
