#include <Arduino.h>
#include <SPI.h>
#include <SD.h>

// ========= Brochage confirmé =========
// FSR (entrées analogiques)
constexpr int PIN_FSR_B = 0;   // GPIO0  (ADC1_CH0)  — FSR_B
constexpr int PIN_FSR_A = 5;   // GPIO5  (ADC1_CH5)  — FSR_A

// Sélection MUX (2 bits -> 4 canaux)
constexpr int PIN_MUX_S0 = 2;  // GPIO2
constexpr int PIN_MUX_S1 = 3;  // GPIO3

// SD (SPI)  —> CS=6, MOSI=7, MISO=9, SCK=8
constexpr int PIN_SD_CS   = 6;   // CS
constexpr int PIN_SD_MOSI = 7;   // DI / MOSI
constexpr int PIN_SD_MISO = 9;   // DO / MISO (attention: pin BOOT sur C3)
constexpr int PIN_SD_SCK  = 8;   // CLK

// ============ Mesure & log ============
const char* LOG_FILE = "/fsr_log.csv";
constexpr int     SAMPLES_PER_READ = 8;     // moyenne pour réduire le bruit
constexpr uint8_t CHANNELS_PER_MUX = 4;     // 0..3
constexpr uint16_t MUX_SETTLE_MS   = 4;     // temps de stabilisation
constexpr uint32_t LOG_PERIOD_MS   = 200;   // 5 Hz
constexpr float   VCC              = 3.30f; // V alim (mesure réelle si possible)
constexpr float   R_FIX            = 10000.0f; // ohms (ex 10k)

// --------- utilitaires ----------
static void muxSelect(uint8_t ch) {
  digitalWrite(PIN_MUX_S0, (ch & 0x01) ? HIGH : LOW);
  digitalWrite(PIN_MUX_S1, (ch & 0x02) ? HIGH : LOW);
}

static int readMilliVoltsAveraged(int pin, int n) {
  long acc = 0;
  for (int i = 0; i < n; ++i) acc += analogReadMilliVolts(pin);
  return (int)(acc / n);
}

static float mvToRfsr(int mv) {
  float v = mv / 1000.0f;
  if (v <= 0.0005f) return INFINITY;     // presque 0V -> R très grande
  if (v >= VCC - 0.01f) return 0.0f;     // presque VCC -> R≈0
  return R_FIX * (VCC / v - 1.0f);
}

static bool sdInitOnce() {
  static bool ok = false;
  if (ok) return true;

  // SPI dédié aux pins que tu utilises
  SPI.begin(PIN_SD_SCK, PIN_SD_MISO, PIN_SD_MOSI);
  if (!SD.begin(PIN_SD_CS, SPI)) {
    Serial.println("[SD] Init KO");
    return false;
  }
  if (!SD.exists(LOG_FILE)) {
    File f = SD.open(LOG_FILE, FILE_WRITE);
    if (f) { f.println("t_ms,fsr,channel,adc_mV,voltage_V,res_ohm"); f.close(); }
  }
  Serial.println("[SD] OK");
  ok = true;
  return true;
}

void setup() {
  Serial.begin(115200);
  delay(300);
  Serial.println("\n[BOOT] ESP32-C3 FSR Logger");

  pinMode(PIN_MUX_S0, OUTPUT);
  pinMode(PIN_MUX_S1, OUTPUT);

  // ADC pleine échelle ~3.6V (ok pour 3.3V)
  analogSetAttenuation(ADC_11db);
  analogSetPinAttenuation(PIN_FSR_A, ADC_11db);
  analogSetPinAttenuation(PIN_FSR_B, ADC_11db);

  sdInitOnce();
  Serial.println("[INIT] OK");
}

void loop() {
  static uint32_t last = 0;
  uint32_t now = millis();
  if (now - last < LOG_PERIOD_MS) { delay(1); return; }
  last = now;

  if (!sdInitOnce()) return;

  File f = SD.open(LOG_FILE, FILE_APPEND);
  if (!f) { Serial.println("[SD] Ouverture CSV KO"); return; }

  for (uint8_t ch = 0; ch < CHANNELS_PER_MUX; ++ch) {
    muxSelect(ch);
    delay(MUX_SETTLE_MS);

    // Lecture des deux branches (deux MUX -> deux ADC)
    int mvB = readMilliVoltsAveraged(PIN_FSR_B, SAMPLES_PER_READ);
    int mvA = readMilliVoltsAveraged(PIN_FSR_A, SAMPLES_PER_READ);
    float vB = mvB / 1000.0f, vA = mvA / 1000.0f;
    float rB = mvToRfsr(mvB),  rA = mvToRfsr(mvA);

    f.printf("%lu,FSR_B,%u,%d,%.4f,%.2f\n", (unsigned long)now, ch, mvB, vB, rB);
    f.printf("%lu,FSR_A,%u,%d,%.4f,%.2f\n", (unsigned long)now, ch, mvA, vA, rA);

    Serial.printf("[CH%u] B=%4d mV (%.1f Ω) | A=%4d mV (%.1f Ω)\n",
                  ch, mvB, rB, mvA, rA);
  }

  f.close();
}
