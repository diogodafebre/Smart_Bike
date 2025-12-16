// Integrated main entry point for Smart Bike
// Coordinates ADC sensor module and web server module

#include "esp_log.h"
#include "esp_task_wdt.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

// Define GPIO inputs analog
#define FSR_B 0  // ADC1 - CH0
#define FSR_A 5  // ADC2 - CH0

// Define GPIO inputs digital
#define BUTTON_GPIO 1  // not used

// Define GPIO outputs
#define LED_GPIO 2    // not used
#define FSR_SEL_A0 3  // for selecting the FSR (mux 2 x 4-to-1)
#define FSR_SEL_A1 4  // for selecting the FSR (mux 2 x 4-to-1)

// Define SD card pins
#define SD_CS 6
#define SD_DI 7
#define SD_CLK 8
#define SD_DO 9

// Define i2c pins for ICM-42670-P
#define I2C_SDA 10
#define I2C_SCL 8

// Define constants
#define FSR_COUNT 8
#define SAMPLING_PERIOD_MS 10
#define ICM_ADDRESS 0x68

static const char* TAG = "MAIN";

/*
Objectifs:
Permet de tester le fonctionnement du PCB pour Smart Bike
Tous les SAMPLING_PERIOD_MS, va lire les 2x4 FSRs
Une fois les FSR lu et stocké dans une variable globale
va aller lire les données de l'IMU ICM-42670-P pour connaitre l'orientation du vélo
Ensuite va afficher les données sur le moniteur série

*/

void app_main(void) {
    ESP_LOGI(TAG, "START");

    while (1) {
    }
}
