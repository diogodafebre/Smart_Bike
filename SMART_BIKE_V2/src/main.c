// Integrated main entry point for Smart Bike
// Coordinates ADC sensor module and web server module

#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "esp_log.h"
#include "esp_task_wdt.h"
#include "shared.h"

static const char *TAG = "SMART_BIKE_MAIN";

void app_main(void)
{
    // Completely disable Task Watchdog (avoids DEADC0DE messages)
    esp_task_wdt_deinit();

    ESP_LOGI(TAG, "=== SMART BIKE V2 ===");
    ESP_LOGI(TAG, "Initializing integrated system...");

    // Initialize sensor module
    sensor_init();

    // Initialize web server module (WiFi + HTTP server)
    web_init();

    // Create sensor task (handles ADC, SD, button, LED)
    xTaskCreate(sensor_task, "sensor_task", 4096, NULL, 5, NULL);

    ESP_LOGI(TAG, "System ready!");
    ESP_LOGI(TAG, "Connect to WiFi AP 'SmartBike' and browse to http://192.168.4.1/");
    ESP_LOGI(TAG, "Press button (GPIO1) to start/stop recording");

    // Main task can just idle (all work is done in other tasks)
    while (1) {
        vTaskDelay(pdMS_TO_TICKS(1000));
    }
}
