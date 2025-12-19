#include <capture.h>

#include "esp_log.h"
#include "esp_task_wdt.h"

static const char TAG[] = "MAIN";

void app_main(void) {
    esp_task_wdt_deinit();
    ESP_LOGI(TAG, "START");
    // 10 seconds delay to allow time for debugger to attach
    // vTaskDelay(10000 / portTICK_PERIOD_MS);
    ESP_LOGI(TAG, "Starting Capture...");

    cpt_init();
    cpt_start_task();

    while (1) {
    }
}