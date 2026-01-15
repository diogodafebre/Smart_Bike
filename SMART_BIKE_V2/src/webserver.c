// Minimal AP (open) + SPIFFS static web server - ESP-IDF version
#include <string.h>
#include <strings.h>
#include <sys/param.h>
#include <sys/stat.h>
#include <dirent.h>
#include <unistd.h>
#include <stdio.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "esp_wifi.h"
#include "esp_event.h"
#include "esp_log.h"
#include "esp_spiffs.h"
#include "esp_http_server.h"
#include "nvs_flash.h"
#include "nvs.h"
#include <ctype.h>
#include "esp_mac.h"
#include <capture.h>  // Access to sensor data from capture library
#include "mdns.h"

static const char* TAG = "SmartBike";
static const char* AP_SSID = "SmartBike"; // open AP (no password)
static httpd_handle_t server = NULL;

// Active runner profile (persisted in NVS)
static char g_active_runner[64] = "";
static bool g_calibration_mode = false;
// WiFi/AP activity tracking
static volatile int g_station_count = 0;
static uint64_t g_last_live_ms = 0;
static int8_t g_current_tx_power = -1; // cached to avoid redundant set calls
static volatile int g_active_transfers = 0; // boost while >0

// TX power levels (ESP-IDF uses 0.25 dBm steps)
#define TX_POWER_MAX 84  // ~21 dBm (reported/logged as ~20 dBm)
#define TX_POWER_LOW 40  // ~10 dBm

static void adjust_tx_power(void) {
  // Decide power based on station presence, recent activity, and active transfers
  int8_t desired = TX_POWER_LOW;
  uint64_t now = cpt_get_time_ms();
  const uint64_t active_window_ms = 5000; // treat activity within last 5s as active

  if (g_active_transfers > 0) {
    desired = TX_POWER_MAX; // always boost during ongoing downloads
  } else if (g_station_count > 0) {
    if (g_last_live_ms != 0 && (now - g_last_live_ms) <= active_window_ms) {
      desired = TX_POWER_MAX; // active streaming
    } else {
      desired = TX_POWER_LOW; // connected but idle
    }
  } else {
    desired = TX_POWER_LOW; // no stations, keep low
  }

  if (desired != g_current_tx_power) {
    esp_err_t err = esp_wifi_set_max_tx_power(desired);
    if (err == ESP_OK) {
      g_current_tx_power = desired;
      ESP_LOGI(TAG, "Adjusted TX power to %d", desired);
    } else {
      ESP_LOGW(TAG, "Failed to adjust TX power: %s", esp_err_to_name(err));
    }
  }
}

static bool is_safe_name(const char* s) {
  // Allow letters, digits, underscore, hyphen, dot
  if (!s || !*s) return false;
  for (const char* p = s; *p; ++p) {
    if (!(isalnum((unsigned char)*p) || *p=='_' || *p=='-' || *p=='.')) return false;
  }
  return true;
}

static void nvs_load_active_runner(void) {
  nvs_handle_t h;
  if (nvs_open("storage", NVS_READONLY, &h) == ESP_OK) {
    size_t len = sizeof(g_active_runner);
    esp_err_t err = nvs_get_str(h, "active_runner", g_active_runner, &len);
    if (err != ESP_OK) {
      g_active_runner[0] = '\0';
    }
    nvs_close(h);
  }
}

static void nvs_load_calibration_mode(void) {
  nvs_handle_t h;
  if (nvs_open("storage", NVS_READONLY, &h) == ESP_OK) {
    uint8_t flag = 0;
    if (nvs_get_u8(h, "calib_mode", &flag) == ESP_OK) {
      g_calibration_mode = (flag != 0);
    }
    nvs_close(h);
  }
}

static void nvs_save_calibration_mode(bool enabled) {
  nvs_handle_t h;
  if (nvs_open("storage", NVS_READWRITE, &h) == ESP_OK) {
    nvs_set_u8(h, "calib_mode", enabled ? 1 : 0);
    nvs_commit(h);
    nvs_close(h);
  }
}

static void nvs_save_active_runner(const char* name) {
  nvs_handle_t h;
  if (nvs_open("storage", NVS_READWRITE, &h) == ESP_OK) {
    nvs_set_str(h, "active_runner", name ? name : "");
    nvs_commit(h);
    nvs_close(h);
  }
}

static const char* contentType(const char* path) {
  const char* ext = strrchr(path, '.');
  if (!ext) return "text/plain";
  
  if (strcmp(ext, ".html") == 0 || strcmp(ext, ".htm") == 0) return "text/html";
  if (strcmp(ext, ".css") == 0)  return "text/css";
  if (strcmp(ext, ".js") == 0)   return "application/javascript";
  if (strcmp(ext, ".png") == 0)  return "image/png";
  if (strcmp(ext, ".jpg") == 0 || strcmp(ext, ".jpeg") == 0) return "image/jpeg";
  if (strcmp(ext, ".svg") == 0)  return "image/svg+xml";
  if (strcmp(ext, ".ico") == 0)  return "image/x-icon";
  if (strcmp(ext, ".json") == 0) return "application/json";
  if (strcmp(ext, ".glb") == 0 || strcmp(ext, ".GLB") == 0) return "model/gltf-binary";
  if (strcmp(ext, ".gltf") == 0 || strcmp(ext, ".GLTF") == 0) return "model/gltf+json";
  if (strcmp(ext, ".gz") == 0) {
    // For .gz files, look at the extension before .gz
    char tmp[256];
    strncpy(tmp, path, sizeof(tmp) - 1);
    tmp[sizeof(tmp) - 1] = '\0';
    char* gz = strstr(tmp, ".gz");
    if (gz) *gz = '\0';
    return contentType(tmp);
  }
  return "text/plain";
}

// Check if string ends with suffix
static bool endsWith(const char* str, const char* suffix) {
  size_t str_len = strlen(str);
  size_t suffix_len = strlen(suffix);
  if (suffix_len > str_len) return false;
  return strcmp(str + str_len - suffix_len, suffix) == 0;
}

// URL decode a string in-place (convert %XX to actual characters)
static void urlDecode(char* str) {
  char* dst = str;
  char* src = str;
  char hex[3] = {0};
  
  while (*src) {
    if (*src == '%' && src[1] && src[2]) {
      hex[0] = src[1];
      hex[1] = src[2];
      hex[2] = '\0';
      *dst++ = (char)strtol(hex, NULL, 16);
      src += 3;
    } else if (*src == '+') {
      *dst++ = ' ';
      src++;
    } else {
      *dst++ = *src++;
    }
  }
  *dst = '\0';
}

// Stream file with proper headers
static esp_err_t streamFile(httpd_req_t *req, const char* filepath, bool isGz) {
  // Boost TX power during file serving (website loads, assets)
  g_active_transfers++;
  esp_wifi_set_max_tx_power(TX_POWER_MAX);
  g_current_tx_power = TX_POWER_MAX;

  FILE* f = fopen(filepath, "r");
  if (!f) {
    ESP_LOGE(TAG, "Failed to open file: %s", filepath);
    g_active_transfers--; adjust_tx_power();
    return ESP_FAIL;
  }

  // Reset to start of file
  fseek(f, 0, SEEK_SET);

  // Determine content type
  const char* mime = contentType(filepath);
  httpd_resp_set_type(req, mime);
  
  // Set headers
  httpd_resp_set_hdr(req, "Connection", "close");
  httpd_resp_set_hdr(req, "Vary", "Accept-Encoding");
  
  if (isGz) {
    httpd_resp_set_hdr(req, "Content-Encoding", "gzip");
  }
  
  bool isHtml = endsWith(filepath, ".html") || endsWith(filepath, ".htm");
  if (isHtml) {
    httpd_resp_set_hdr(req, "Cache-Control", "no-store, must-revalidate");
  } else {
    httpd_resp_set_hdr(req, "Cache-Control", "public, max-age=86400");
  }

  // Stream file in chunks
  char buf[1024];  // Smaller buffer for better reliability
  size_t total = 0;
  while (!feof(f)) {
    size_t n = fread(buf, 1, sizeof(buf), f);
    if (n > 0) {
      if (httpd_resp_send_chunk(req, buf, n) != ESP_OK) {
        fclose(f);
        ESP_LOGE(TAG, "Failed to send chunk for %s", filepath);
        g_active_transfers--; adjust_tx_power();
        return ESP_FAIL;
      }
      total += n;
    }
    // Small delay to prevent overwhelming the connection
    vTaskDelay(pdMS_TO_TICKS(1));
  }
  
  // End response
  httpd_resp_send_chunk(req, NULL, 0);
  fclose(f);
  ESP_LOGI(TAG, "Sent %s (%d bytes)", filepath, total);
  g_active_transfers--; adjust_tx_power();
  return ESP_OK;
}

// Check if file exists
static bool fileExists(const char* path) {
  struct stat st;
  return (stat(path, &st) == 0);
}

// Serve a file from SPIFFS or SD card
static esp_err_t serveFile(httpd_req_t *req, const char* uri) {
  char filepath[256];
  
  // Build filesystem path
  if (strcmp(uri, "/") == 0) {
    snprintf(filepath, sizeof(filepath), "/spiffs/index.html");
  } else {
    snprintf(filepath, sizeof(filepath), "/spiffs%s", uri);
  }

  // 1) Try exact file in SPIFFS
  if (fileExists(filepath)) {
    bool isGz = endsWith(filepath, ".gz");
    return streamFile(req, filepath, isGz);
  }

  // 2) Try gzip version in SPIFFS
  char gzpath[260];
  snprintf(gzpath, sizeof(gzpath), "%s.gz", filepath);
  if (fileExists(gzpath)) {
    // Check if client accepts gzip
    size_t hdr_len = httpd_req_get_hdr_value_len(req, "Accept-Encoding");
    bool acceptsGzip = false;
    if (hdr_len > 0) {
      char* ae = (char*)malloc(hdr_len + 1);
      if (ae && httpd_req_get_hdr_value_str(req, "Accept-Encoding", ae, hdr_len + 1) == ESP_OK) {
        acceptsGzip = (strstr(ae, "gzip") != NULL);
      }
      free(ae);
    }
    
    if (!acceptsGzip) {
      bool isHtml = endsWith(filepath, ".html") || endsWith(filepath, ".htm");
      if (isHtml) {
        const char* fallback = 
          "<!doctype html><meta charset=\"utf-8\"><title>SmartBike</title>"
          "<p>Your browser did not advertise gzip support. Please try another browser/device.</p>";
        httpd_resp_send(req, fallback, HTTPD_RESP_USE_STRLEN);
      } else {
        httpd_resp_set_status(req, "406 Not Acceptable");
        httpd_resp_set_type(req, "text/plain");
        httpd_resp_send(req, "gzip required", HTTPD_RESP_USE_STRLEN);
      }
      return ESP_OK;
    }
    
    return streamFile(req, gzpath, true);
  }

  // 3) Try SD card (for model files and other assets) — no fallbacks, no directory dumps
  char sdpath[256];
  snprintf(sdpath, sizeof(sdpath), "/sdcard%s", uri);
  if (fileExists(sdpath)) {
    bool isGz = endsWith(sdpath, ".gz") || endsWith(sdpath, ".GZ");
    return streamFile(req, sdpath, isGz);
  }

  ESP_LOGE(TAG, "File not found: %s (SPIFFS: %s | SPIFFS.gz: %s | SD: %s)", 
           uri, filepath, gzpath, sdpath);
  return ESP_FAIL;
}

// HTTP GET handler for root
static esp_err_t root_handler(httpd_req_t *req) {
  if (serveFile(req, "/index.html") == ESP_OK) {
    return ESP_OK;
  }
  
  // Fallback if index.html not found
  const char* fallback =
    "<!doctype html><html><head><meta charset='utf-8'>"
    "<meta name='viewport' content='width=device-width, initial-scale=1'>"
    "<title>SmartBike</title>"
    "<style>body{font-family:system-ui,Segoe UI,Arial,sans-serif;margin:2rem;}"
    "h1{margin:0 0 1rem;}code{background:#eee;padding:.2rem .4rem;border-radius:.25rem;}"
    "a{color:#06c;text-decoration:none;}a:hover{text-decoration:underline}</style>"
    "</head><body>"
    "<h1>SmartBike</h1>"
    "<p>index.html not found in SPIFFS. Put your site in the project's <code>data/</code> folder and run the PlatformIO task: Upload Filesystem Image.</p>"
    "<p>Then reconnect to Wi‑Fi AP <code>SmartBike</code> and open <code>http://192.168.4.1/</code>.</p>"
    "<p>Try <a href='/ls'>/ls</a> to see SPIFFS contents.</p>"
    "</body></html>";
  httpd_resp_send(req, fallback, HTTPD_RESP_USE_STRLEN);
  return ESP_OK;
}

// HTTP GET handler for /ls (list files)
static esp_err_t ls_handler(httpd_req_t *req) {
  DIR* dir = opendir("/spiffs");
  if (!dir) {
    httpd_resp_send_err(req, HTTPD_500_INTERNAL_SERVER_ERROR, "open root failed");
    return ESP_FAIL;
  }

  // Build file list
  char* out = (char*)malloc(4096);
  if (!out) {
    closedir(dir);
    httpd_resp_send_err(req, HTTPD_500_INTERNAL_SERVER_ERROR, "malloc failed");
    return ESP_FAIL;
  }
  out[0] = '\0';
  
  struct dirent* entry;
  while ((entry = readdir(dir)) != NULL) {
    if (entry->d_type == DT_REG) {
      char fpath[512];
      snprintf(fpath, sizeof(fpath), "/spiffs/%s", entry->d_name);
      struct stat st;
      if (stat(fpath, &st) == 0) {
        char line[300];
        snprintf(line, sizeof(line), "%s\t%ld\n", entry->d_name, (long)st.st_size);
        strcat(out, line);
      }
    }
  }
  closedir(dir);
  
  if (strlen(out) == 0) {
    strcpy(out, "<empty>\n");
  }
  
  httpd_resp_set_type(req, "text/plain");
  httpd_resp_send(req, out, HTTPD_RESP_USE_STRLEN);
  free(out);
  return ESP_OK;
}

// HTTP GET handler for /download
static esp_err_t download_handler(httpd_req_t *req) {
  // Boost TX power for the duration of this transfer
  g_active_transfers++;
  esp_wifi_set_max_tx_power(TX_POWER_MAX);
  g_current_tx_power = TX_POWER_MAX;

  char query[256];
  if (httpd_req_get_url_query_str(req, query, sizeof(query)) != ESP_OK) {
    httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "missing f param");
    g_active_transfers--; adjust_tx_power();
    return ESP_FAIL;
  }
  
  char param[128];
  if (httpd_query_key_value(query, "f", param, sizeof(param)) != ESP_OK) {
    httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "missing f param");
    g_active_transfers--; adjust_tx_power();
    return ESP_FAIL;
  }
  
  char filepath[256];
  if (param[0] == '/') {
    snprintf(filepath, sizeof(filepath), "/spiffs%s", param);
  } else {
    snprintf(filepath, sizeof(filepath), "/spiffs/%s", param);
  }
  
  if (!fileExists(filepath)) {
    httpd_resp_send_err(req, HTTPD_404_NOT_FOUND, "not found");
    g_active_transfers--; adjust_tx_power();
    return ESP_FAIL;
  }
  
  FILE* f = fopen(filepath, "r");
  if (!f) {
    httpd_resp_send_err(req, HTTPD_500_INTERNAL_SERVER_ERROR, "open failed");
    g_active_transfers--; adjust_tx_power();
    return ESP_FAIL;
  }
  
  httpd_resp_set_type(req, "application/octet-stream");
  
  char buf[1024];
  while (!feof(f)) {
    size_t n = fread(buf, 1, sizeof(buf), f);
    if (n > 0) {
      if (httpd_resp_send_chunk(req, buf, n) != ESP_OK) {
        fclose(f);
        g_active_transfers--; adjust_tx_power();
        return ESP_FAIL;
      }
    }
    vTaskDelay(pdMS_TO_TICKS(1));
  }
  httpd_resp_send_chunk(req, NULL, 0);
  fclose(f);
  g_active_transfers--; adjust_tx_power();
  return ESP_OK;
}

// API endpoint: /api/live - Returns current ADC sensor data as JSON
static esp_err_t api_live_handler(httpd_req_t *req) {
  char json[1024];

  float roll = 0.0f, pitch = 0.0f;
  cpt_get_latest_angles(&roll, &pitch);
  uint64_t timestamp_ms = cpt_get_time_ms();
  bool active = cpt_is_running();
  uint32_t run_id = cpt_get_run_id();

  int len = 0;
  if (g_calibration_mode) {
    int raw_adc[8] = {0};
    float raw_volt[8] = {0};
    cpt_get_latest_raw_adc(raw_adc);
    for (int i = 0; i < 8; i++) {
      raw_volt[i] = (raw_adc[i] * 3.3f) / 4095.0f;
    }

    len = snprintf(json, sizeof(json),
      "{\"timestamp\":%llu,\"active\":%s,\"run_id\":%lu,\"roll\":%.2f,\"pitch\":%.2f,\"calib_mode\":true,"
      "\"raw_adc\":[%d,%d,%d,%d,%d,%d,%d,%d],"
      "\"raw_volt\":[%.4f,%.4f,%.4f,%.4f,%.4f,%.4f,%.4f,%.4f]}",
      timestamp_ms,
      active ? "true" : "false",
      (unsigned long)run_id,
      roll,
      pitch,
      raw_adc[0], raw_adc[1], raw_adc[2], raw_adc[3], raw_adc[4], raw_adc[5], raw_adc[6], raw_adc[7],
      raw_volt[0], raw_volt[1], raw_volt[2], raw_volt[3], raw_volt[4], raw_volt[5], raw_volt[6], raw_volt[7]
    );
  } else {
    float voltages[8];
    cpt_get_latest_voltages(voltages);

    len = snprintf(json, sizeof(json),
      "{\"timestamp\":%llu,\"active\":%s,\"run_id\":%lu,\"roll\":%.2f,\"pitch\":%.2f,\"calib_mode\":false,\"sensors\":["
      "%.4f,%.4f,%.4f,%.4f,%.4f,%.4f,%.4f,%.4f]}",
      timestamp_ms,
      active ? "true" : "false",
      (unsigned long)run_id,
      roll,
      pitch,
      voltages[0], voltages[1], voltages[2], voltages[3],
      voltages[4], voltages[5], voltages[6], voltages[7]
    );
  }

  httpd_resp_set_type(req, "application/json");
  httpd_resp_set_hdr(req, "Access-Control-Allow-Origin", "*");
  httpd_resp_send(req, json, len);
  // Mark activity and adjust TX power
  g_last_live_ms = timestamp_ms;
  adjust_tx_power();
  return ESP_OK;
}

// API: POST /api/run/start - start recording
static esp_err_t api_run_start_handler(httpd_req_t *req) {
  cpt_start();
  httpd_resp_set_type(req, "application/json");
  httpd_resp_set_hdr(req, "Access-Control-Allow-Origin", "*");
  httpd_resp_send(req, "{\"ok\":true,\"active\":true}", HTTPD_RESP_USE_STRLEN);
  return ESP_OK;
}

// API: POST /api/run/stop - stop recording
static esp_err_t api_run_stop_handler(httpd_req_t *req) {
  cpt_stop();
  httpd_resp_set_type(req, "application/json");
  httpd_resp_set_hdr(req, "Access-Control-Allow-Origin", "*");
  httpd_resp_send(req, "{\"ok\":true,\"active\":false}", HTTPD_RESP_USE_STRLEN);
  return ESP_OK;
}

// API endpoint: /api/runs - List RUN files from SD card
static esp_err_t api_runs_handler(httpd_req_t *req) {
  DIR* dir = opendir("/sdcard");
  if (!dir) {
    // SD card not available
    httpd_resp_set_type(req, "application/json");
    httpd_resp_send(req, "[]", 2);
    return ESP_OK;
  }
  
  char* json = (char*)malloc(2048);
  if (!json) {
    closedir(dir);
    httpd_resp_send_err(req, HTTPD_500_INTERNAL_SERVER_ERROR, "malloc failed");
    return ESP_FAIL;
  }
  
  strcpy(json, "[");
  bool first = true;
  struct dirent* entry;
  
  while ((entry = readdir(dir)) != NULL) {
    if (entry->d_type == DT_REG) {
      // Check if it's a RUN file (.CSV or .txt)
      // Supports: RUNxx.CSV (old) and RUN_xxx.txt (new)
      const char* name = entry->d_name;
      if (strstr(name, "RUN") == name) {
        const char* ext = strrchr(name, '.');
        if (ext && (strcasecmp(ext, ".CSV") == 0 || strcasecmp(ext, ".txt") == 0)) {
          if (!first) strcat(json, ",");
          strcat(json, "\"");
          strcat(json, name);
          strcat(json, "\"");
          first = false;
        }
      }
    }
  }
  strcat(json, "]");
  closedir(dir);
  
  httpd_resp_set_type(req, "application/json");
  httpd_resp_set_hdr(req, "Access-Control-Allow-Origin", "*");
  httpd_resp_send(req, json, strlen(json));
  free(json);
  return ESP_OK;
}

// API: GET /api/runners -> list runner directories on SD root, also returns active
static esp_err_t api_runners_handler(httpd_req_t *req) {
  DIR* dir = opendir("/sdcard");
  httpd_resp_set_type(req, "application/json");
  httpd_resp_set_hdr(req, "Access-Control-Allow-Origin", "*");
  if (!dir) {
    httpd_resp_send(req, "{\"runners\":[],\"active\":\"\"}", HTTPD_RESP_USE_STRLEN);
    return ESP_OK;
  }

  // Build JSON array of directory names
  char* json = (char*)malloc(2048);
  if (!json) { closedir(dir); httpd_resp_send_err(req, HTTPD_500_INTERNAL_SERVER_ERROR, "malloc failed"); return ESP_FAIL; }
  strcpy(json, "{\"runners\":[");
  bool first = true;
  struct dirent* e;
  while ((e = readdir(dir)) != NULL) {
    if (e->d_type == DT_DIR) {
      if (strcmp(e->d_name, ".")==0 || strcmp(e->d_name, "..")==0) continue;
      // include all dirs
      if (!first) strcat(json, ",");
      strcat(json, "\"");
      strcat(json, e->d_name);
      strcat(json, "\"");
      first = false;
    }
  }
  closedir(dir);
  strcat(json, "],\"active\":\"");
  strcat(json, g_active_runner);
  strcat(json, "\"}");
  httpd_resp_send(req, json, HTTPD_RESP_USE_STRLEN);
  free(json);
  return ESP_OK;
}

// API: GET /api/runs-in?runner=<folder> -> list RUN*.CSV inside folder
static esp_err_t api_runs_in_handler(httpd_req_t *req) {
  char query[256];
  char runner[128] = {0};
  if (httpd_req_get_url_query_str(req, query, sizeof(query)) == ESP_OK) {
    httpd_query_key_value(query, "runner", runner, sizeof(runner));
  }
  if (!*runner) {
    // default to root of SD
    strcpy(runner, ".");
  }
  if (!is_safe_name(runner) && strcmp(runner, ".")!=0) {
    httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "bad runner");
    return ESP_FAIL;
  }
  char base[256];
  if (strcmp(runner, ".") == 0) snprintf(base, sizeof(base), "/sdcard");
  else snprintf(base, sizeof(base), "/sdcard/%s", runner);
  DIR* dir = opendir(base);
  httpd_resp_set_type(req, "application/json");
  httpd_resp_set_hdr(req, "Access-Control-Allow-Origin", "*");
  if (!dir) { httpd_resp_send(req, "[]", 2); return ESP_OK; }
  char* json = (char*)malloc(2048);
  if (!json) { closedir(dir); httpd_resp_send_err(req, HTTPD_500_INTERNAL_SERVER_ERROR, "malloc failed"); return ESP_FAIL; }
  strcpy(json, "["); bool first = true; struct dirent* e;
  while ((e = readdir(dir)) != NULL) {
    if (e->d_type == DT_REG) {
      // Check if it's a RUN file (.CSV or .txt)
      // Supports: RUNxx.CSV (old) and RUN_xxx.txt (new)
      const char* name = e->d_name;
      if (strstr(name, "RUN") == name) {
        const char* ext = strrchr(name, '.');
        if (ext && (strcasecmp(ext, ".CSV") == 0 || strcasecmp(ext, ".txt") == 0)) {
          if (!first) strcat(json, ",");
          strcat(json, "\""); strcat(json, name); strcat(json, "\"");
          first = false;
        }
      }
    }
  }
  closedir(dir);
  strcat(json, "]");
  httpd_resp_send(req, json, strlen(json));
  free(json);
  return ESP_OK;
}

// API: POST /api/move-run with form body src=<from>&dst=<to>
static esp_err_t api_move_run_handler(httpd_req_t *req) {
  char buf[256]; int total = 0; int to_read = req->content_len;
  while (to_read > 0 && total < (int)sizeof(buf)-1) {
    int r = httpd_req_recv(req, buf + total, to_read > (int)sizeof(buf)-1-total ? (int)sizeof(buf)-1-total : to_read);
    if (r <= 0) {
      break;
    }
    total += r;
    to_read -= r;
  }
  buf[total] = '\0';
  // Expect urlencoded: src=unsorted_run%2FRUN1.CSV&dst=Alice%2FRUN1.CSV
  char* srcp = strstr(buf, "src=");
  char* dstp = strstr(buf, "dst=");
  if (!srcp || !dstp) { httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "missing params"); return ESP_FAIL; }
  // crude parse
  char src[160] = {0}, dst[160] = {0};
  sscanf(srcp, "src=%159[^&]", src);
  sscanf(dstp, "dst=%159[^&]", dst);
  // decode %2F only (we only need slash), replace %2F with '/'
  for (char* p = src; *p; ++p) if (*p=='%') { if (p[1]=='2'&&(p[2]=='F'||p[2]=='f')) { *p='/'; memmove(p+1, p+3, strlen(p+3)+1);} }
  for (char* p = dst; *p; ++p) if (*p=='%') { if (p[1]=='2'&&(p[2]=='F'||p[2]=='f')) { *p='/'; memmove(p+1, p+3, strlen(p+3)+1);} }
  // Validate components: expect form "folder/file"
  char srcFolder[100]={0}, srcFile[100]={0};
  char dstFolder[100]={0}, dstFile[100]={0};
  sscanf(src, "%99[^/]/%99s", srcFolder, srcFile);
  sscanf(dst, "%99[^/]/%99s", dstFolder, dstFile);
  if (!is_safe_name(srcFolder) || !is_safe_name(srcFile) || !is_safe_name(dstFolder) || !is_safe_name(dstFile)) {
    httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "bad names");
    return ESP_FAIL;
  }
  
  // Build paths, handling root directory (.) specially
  char fromPath[256];
  if (strcmp(srcFolder, ".") == 0) {
    snprintf(fromPath, sizeof(fromPath), "/sdcard/%s", srcFile);
  } else {
    snprintf(fromPath, sizeof(fromPath), "/sdcard/%s/%s", srcFolder, srcFile);
  }
  
  char toDir[256];
  if (strcmp(dstFolder, ".") == 0) {
    snprintf(toDir, sizeof(toDir), "/sdcard");
  } else {
    snprintf(toDir, sizeof(toDir), "/sdcard/%s", dstFolder);
  }
  
  char toPath[256];
  if (strcmp(dstFolder, ".") == 0) {
    snprintf(toPath, sizeof(toPath), "/sdcard/%s", dstFile);
  } else {
    snprintf(toPath, sizeof(toPath), "/sdcard/%s/%s", dstFolder, dstFile);
  }
  
  // ensure dest dir exists
  struct stat st; if (stat(toDir, &st) != 0) { mkdir(toDir, 0775); }
  // move
  if (rename(fromPath, toPath) != 0) {
    httpd_resp_send_err(req, HTTPD_500_INTERNAL_SERVER_ERROR, "rename failed");
    return ESP_FAIL;
  }
  httpd_resp_set_type(req, "application/json");
  httpd_resp_set_hdr(req, "Access-Control-Allow-Origin", "*");
  httpd_resp_send(req, "{\"ok\":true}", HTTPD_RESP_USE_STRLEN);
  return ESP_OK;
}

// API: POST /api/create-runner with form body name=<runner>
static esp_err_t api_create_runner_handler(httpd_req_t *req) {
  char buf[96]; int total=0; int to_read=req->content_len;
  while (to_read>0 && total<(int)sizeof(buf)-1) {
    int r=httpd_req_recv(req, buf+total, to_read > (int)sizeof(buf)-1-total ? (int)sizeof(buf)-1-total : to_read);
    if (r<=0) {
      break;
    }
    total+=r;
    to_read-=r;
  }
  buf[total]='\0';
  char* np = strstr(buf, "name=");
  if (!np) { httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "missing name"); return ESP_FAIL; }
  char name[64]={0}; sscanf(np, "name=%63[^&]", name);
  if (!is_safe_name(name)) { httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "bad name"); return ESP_FAIL; }
  char dir[160]; snprintf(dir, sizeof(dir), "/sdcard/%s", name);
  struct stat st; if (stat(dir, &st)==0 && S_ISDIR(st.st_mode)) {
    httpd_resp_set_type(req, "application/json");
    httpd_resp_send(req, "{\"ok\":true,\"exists\":true}", HTTPD_RESP_USE_STRLEN);
    return ESP_OK;
  }
  if (mkdir(dir, 0775) != 0) { httpd_resp_send_err(req, HTTPD_500_INTERNAL_SERVER_ERROR, "mkdir failed"); return ESP_FAIL; }
  httpd_resp_set_type(req, "application/json");
  httpd_resp_send(req, "{\"ok\":true}", HTTPD_RESP_USE_STRLEN);
  return ESP_OK;
}

// API: POST /api/rename-run with form body folder=<folder>&old=<oldname>&new=<newname>
static esp_err_t api_rename_run_handler(httpd_req_t *req) {
  char buf[256]; int total=0; int to_read=req->content_len;
  while (to_read>0 && total<(int)sizeof(buf)-1) {
    int r=httpd_req_recv(req, buf+total, to_read > (int)sizeof(buf)-1-total ? (int)sizeof(buf)-1-total : to_read);
    if (r<=0) {
      break;
    }
    total+=r;
    to_read-=r;
  }
  buf[total]='\0';
  char folder[100]={0}, oldname[100]={0}, newname[100]={0};
  char* fp=strstr(buf,"folder="); char* op=strstr(buf,"old="); char* np=strstr(buf,"new=");
  if (!fp||!op||!np) { httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "missing params"); return ESP_FAIL; }
  sscanf(fp, "folder=%99[^&]", folder); sscanf(op, "old=%99[^&]", oldname); sscanf(np, "new=%99[^&]", newname);
  // decode %2F
  for (char* p=folder; *p; ++p) if (*p=='%'&&p[1]=='2'&&(p[2]=='F'||p[2]=='f')) { *p='/'; memmove(p+1,p+3,strlen(p+3)+1);}
  for (char* p=oldname; *p; ++p) if (*p=='%'&&p[1]=='2'&&(p[2]=='F'||p[2]=='f')) { *p='/'; memmove(p+1,p+3,strlen(p+3)+1);}
  for (char* p=newname; *p; ++p) if (*p=='%'&&p[1]=='2'&&(p[2]=='F'||p[2]=='f')) { *p='/'; memmove(p+1,p+3,strlen(p+3)+1);}
  if (!is_safe_name(folder)||!is_safe_name(oldname)||!is_safe_name(newname)) {
    httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "bad names"); return ESP_FAIL;
  }
  char oldPath[256]; snprintf(oldPath, sizeof(oldPath), "/sdcard/%s/%s", folder, oldname);
  char newPath[256]; snprintf(newPath, sizeof(newPath), "/sdcard/%s/%s", folder, newname);
  if (rename(oldPath, newPath)!=0) { httpd_resp_send_err(req, HTTPD_500_INTERNAL_SERVER_ERROR, "rename failed"); return ESP_FAIL; }
  httpd_resp_set_type(req, "application/json");
  httpd_resp_set_hdr(req, "Access-Control-Allow-Origin", "*");
  httpd_resp_send(req, "{\"ok\":true}", HTTPD_RESP_USE_STRLEN);
  return ESP_OK;
}

// API: POST /api/delete-run with form body folder=<folder>&file=<filename>
static esp_err_t api_delete_run_handler(httpd_req_t *req) {
  char buf[200]; int total=0; int to_read=req->content_len;
  while (to_read>0 && total<(int)sizeof(buf)-1) {
    int r=httpd_req_recv(req, buf+total, to_read > (int)sizeof(buf)-1-total ? (int)sizeof(buf)-1-total : to_read);
    if (r<=0) {
      break;
    }
    total+=r;
    to_read-=r;
  }
  buf[total]='\0';
  char folder[100]={0}, file[100]={0};
  char* fp=strstr(buf,"folder="); char* ffp=strstr(buf,"file=");
  if (!fp||!ffp) { httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "missing params"); return ESP_FAIL; }
  sscanf(fp, "folder=%99[^&]", folder); sscanf(ffp, "file=%99[^&]", file);
  for (char* p=folder; *p; ++p) if (*p=='%'&&p[1]=='2'&&(p[2]=='F'||p[2]=='f')) { *p='/'; memmove(p+1,p+3,strlen(p+3)+1);}
  for (char* p=file; *p; ++p) if (*p=='%'&&p[1]=='2'&&(p[2]=='F'||p[2]=='f')) { *p='/'; memmove(p+1,p+3,strlen(p+3)+1);}
  // Allow "." for root folder, otherwise check if safe
  if (strcmp(folder, ".") != 0 && !is_safe_name(folder)) { httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "bad folder"); return ESP_FAIL; }
  if (!is_safe_name(file)) { httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "bad filename"); return ESP_FAIL; }
  // Build path: if folder is ".", use root directly
  char path[256]; 
  if (strcmp(folder, ".") == 0) {
    snprintf(path, sizeof(path), "/sdcard/%s", file);
  } else {
    snprintf(path, sizeof(path), "/sdcard/%s/%s", folder, file);
  }
  if (unlink(path)!=0) { httpd_resp_send_err(req, HTTPD_500_INTERNAL_SERVER_ERROR, "delete failed"); return ESP_FAIL; }
  httpd_resp_set_type(req, "application/json");
  httpd_resp_set_hdr(req, "Access-Control-Allow-Origin", "*");
  httpd_resp_send(req, "{\"ok\":true}", HTTPD_RESP_USE_STRLEN);
  return ESP_OK;
}

// API: GET/POST /api/active-runner
static esp_err_t api_active_runner_get(httpd_req_t *req) {
  httpd_resp_set_type(req, "application/json");
  httpd_resp_set_hdr(req, "Access-Control-Allow-Origin", "*");
  char out[96]; snprintf(out, sizeof(out), "{\"active\":\"%s\"}", g_active_runner);
  httpd_resp_send(req, out, HTTPD_RESP_USE_STRLEN);
  return ESP_OK;
}
static esp_err_t api_active_runner_post(httpd_req_t *req) {
  char buf[128]; int total=0; int to_read=req->content_len;
  while (to_read>0 && total< (int)sizeof(buf)-1) {
    int r=httpd_req_recv(req, buf+total, to_read > (int)sizeof(buf)-1-total ? (int)sizeof(buf)-1-total : to_read);
    if (r<=0) {
      break;
    }
    total+=r;
    to_read-=r;
  }
  buf[total]='\0';
  // expect body runner=<name>
  char* rp = strstr(buf, "runner=");
  if (!rp) { httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "missing runner"); return ESP_FAIL; }
  char name[64]={0}; sscanf(rp, "runner=%63[^&]", name);
  // decode + to space? we don't allow spaces. Keep simple.
  if (!is_safe_name(name)) { httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "bad name"); return ESP_FAIL; }
  strncpy(g_active_runner, name, sizeof(g_active_runner)-1);
  nvs_save_active_runner(g_active_runner);
  httpd_resp_set_type(req, "application/json");
  httpd_resp_set_hdr(req, "Access-Control-Allow-Origin", "*");
  httpd_resp_send(req, "{\"ok\":true}", HTTPD_RESP_USE_STRLEN);
  return ESP_OK;
}

// API: GET/POST /api/calibration-mode
static esp_err_t api_calibration_get(httpd_req_t *req) {
  httpd_resp_set_type(req, "application/json");
  httpd_resp_set_hdr(req, "Access-Control-Allow-Origin", "*");
  char out[64]; snprintf(out, sizeof(out), "{\"calib_mode\":%s}", g_calibration_mode ? "true" : "false");
  httpd_resp_send(req, out, HTTPD_RESP_USE_STRLEN);
  return ESP_OK;
}

static esp_err_t api_calibration_post(httpd_req_t *req) {
  char buf[64]; int total = 0; int to_read = req->content_len;
  while (to_read > 0 && total < (int)sizeof(buf) - 1) {
    int r = httpd_req_recv(req, buf + total, to_read > (int)sizeof(buf) - 1 - total ? (int)sizeof(buf) - 1 - total : to_read);
    if (r <= 0) {
      break;
    }
    total += r;
    to_read -= r;
  }
  buf[total] = '\0';

  char* mp = strstr(buf, "mode=");
  if (!mp) { httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "missing mode"); return ESP_FAIL; }

  char val[16] = {0};
  sscanf(mp, "mode=%15[^&]", val);
  bool enable = (strcasecmp(val, "true") == 0 || strcmp(val, "1") == 0 || strcasecmp(val, "on") == 0);
  g_calibration_mode = enable;
  nvs_save_calibration_mode(g_calibration_mode);

  httpd_resp_set_type(req, "application/json");
  httpd_resp_set_hdr(req, "Access-Control-Allow-Origin", "*");
  char out[80]; snprintf(out, sizeof(out), "{\"ok\":true,\"calib_mode\":%s}", g_calibration_mode ? "true" : "false");
  httpd_resp_send(req, out, HTTPD_RESP_USE_STRLEN);
  return ESP_OK;
}

// API endpoint: /api/runs/<filename> - Download a specific RUN file from SD
static esp_err_t api_run_file_handler(httpd_req_t *req) {
  // Boost TX power for the duration of this transfer
  g_active_transfers++;
  esp_wifi_set_max_tx_power(TX_POWER_MAX);
  g_current_tx_power = TX_POWER_MAX;

  // Extract path from URI (e.g., /api/runs/RUN1.CSV or /api/runs/PROFILE/RUN1.CSV)
  const char* uri = req->uri;
  const char* pathStart = strstr(uri, "/api/runs/");
  if (!pathStart) {
    httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "Invalid URI");
    g_active_transfers--; adjust_tx_power();
    return ESP_FAIL;
  }
  pathStart += strlen("/api/runs/");
  
  if (strlen(pathStart) == 0) {
    httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "Missing filename");
    g_active_transfers--; adjust_tx_power();
    return ESP_FAIL;
  }
  
  // Copy and decode the path (handles %2F -> / conversion)
  char decodedPath[240];
  strncpy(decodedPath, pathStart, sizeof(decodedPath) - 1);
  decodedPath[sizeof(decodedPath) - 1] = '\0';
  urlDecode(decodedPath);
  
  char filepath[256];
  snprintf(filepath, sizeof(filepath), "/sdcard/%s", decodedPath);
  
  FILE* f = fopen(filepath, "r");
  if (!f) {
    ESP_LOGE(TAG, "File not found: %s", filepath);
    httpd_resp_send_err(req, HTTPD_404_NOT_FOUND, "File not found");
    g_active_transfers--; adjust_tx_power();
    return ESP_FAIL;
  }
  
  httpd_resp_set_type(req, "text/csv");
  httpd_resp_set_hdr(req, "Access-Control-Allow-Origin", "*");
  
  char buf[1024];
  while (!feof(f)) {
    size_t n = fread(buf, 1, sizeof(buf), f);
    if (n > 0) {
      if (httpd_resp_send_chunk(req, buf, n) != ESP_OK) {
        fclose(f);
        g_active_transfers--; adjust_tx_power();
        return ESP_FAIL;
      }
    }
  }
  httpd_resp_send_chunk(req, NULL, 0);
  fclose(f);
  ESP_LOGI(TAG, "Sent file: %s", filepath);
  g_active_transfers--; adjust_tx_power();
  return ESP_OK;
}

// Generic handler for serving static files
static esp_err_t static_handler(httpd_req_t *req) {
  if (serveFile(req, req->uri) == ESP_OK) {
    return ESP_OK;
  }
  
  char msg[600];
  snprintf(msg, sizeof(msg), "Not found: %s", req->uri);
  httpd_resp_send_err(req, HTTPD_404_NOT_FOUND, msg);
  return ESP_FAIL;
}

// Initialize SPIFFS
static void init_spiffs(void) {
  ESP_LOGI(TAG, "Initializing SPIFFS");
  
  esp_vfs_spiffs_conf_t conf = {
    .base_path = "/spiffs",
    .partition_label = NULL,
    .max_files = 5,
    .format_if_mount_failed = true
  };
  
  esp_err_t ret = esp_vfs_spiffs_register(&conf);
  if (ret != ESP_OK) {
    if (ret == ESP_FAIL) {
      ESP_LOGE(TAG, "Failed to mount or format filesystem");
    } else if (ret == ESP_ERR_NOT_FOUND) {
      ESP_LOGE(TAG, "Failed to find SPIFFS partition");
    } else {
      ESP_LOGE(TAG, "Failed to initialize SPIFFS (%s)", esp_err_to_name(ret));
    }
    return;
  }
  
  size_t total = 0, used = 0;
  ret = esp_spiffs_info(NULL, &total, &used);
  if (ret == ESP_OK) {
    ESP_LOGI(TAG, "SPIFFS: %d KB total, %d KB used", total / 1024, used / 1024);
  }
}

// WiFi event handler
static void wifi_event_handler(void* arg, esp_event_base_t event_base,
                                int32_t event_id, void* event_data) {
  if (event_id == WIFI_EVENT_AP_STACONNECTED) {
    wifi_event_ap_staconnected_t* event = (wifi_event_ap_staconnected_t*) event_data;
    ESP_LOGI(TAG, "Station " MACSTR " joined, AID=%d",
             MAC2STR(event->mac), event->aid);
    g_station_count++;
    adjust_tx_power();
  } else if (event_id == WIFI_EVENT_AP_STADISCONNECTED) {
    wifi_event_ap_stadisconnected_t* event = (wifi_event_ap_stadisconnected_t*) event_data;
    ESP_LOGI(TAG, "Station " MACSTR " left, AID=%d",
             MAC2STR(event->mac), event->aid);
    if (g_station_count > 0) g_station_count--;
    adjust_tx_power();
  }
}

// Initialize WiFi AP
static void init_wifi_ap(void) {
  ESP_ERROR_CHECK(esp_netif_init());
  ESP_ERROR_CHECK(esp_event_loop_create_default());
  esp_netif_create_default_wifi_ap();

  wifi_init_config_t cfg = WIFI_INIT_CONFIG_DEFAULT();
  ESP_ERROR_CHECK(esp_wifi_init(&cfg));

  ESP_ERROR_CHECK(esp_event_handler_instance_register(WIFI_EVENT,
                                                      ESP_EVENT_ANY_ID,
                                                      &wifi_event_handler,
                                                      NULL,
                                                      NULL));

  wifi_config_t wifi_config = {};
  memcpy(wifi_config.ap.ssid, "SmartBike", strlen("SmartBike"));
  wifi_config.ap.ssid_len = strlen("SmartBike");
  wifi_config.ap.channel = 1;
  wifi_config.ap.password[0] = '\0';
  wifi_config.ap.max_connection = 4;
  wifi_config.ap.authmode = WIFI_AUTH_OPEN;

  ESP_ERROR_CHECK(esp_wifi_set_mode(WIFI_MODE_AP));
  ESP_ERROR_CHECK(esp_wifi_set_config(WIFI_IF_AP, &wifi_config));
  ESP_ERROR_CHECK(esp_wifi_start());

  // Start with low TX power until activity is detected
  esp_err_t power_err = esp_wifi_set_max_tx_power(TX_POWER_LOW);
  if (power_err == ESP_OK) {
    g_current_tx_power = TX_POWER_LOW;
    ESP_LOGI(TAG, "WiFi TX power initialized to %d (~10 dBm)", TX_POWER_LOW);
  } else {
    ESP_LOGW(TAG, "Failed to initialize WiFi TX power: %s", esp_err_to_name(power_err));
  }

  ESP_LOGI(TAG, "WiFi AP started. SSID: %s", AP_SSID);
  ESP_LOGI(TAG, "AP IP: 192.168.4.1");
}

// Start HTTP server
static httpd_handle_t start_webserver(void) {
  httpd_config_t config = HTTPD_DEFAULT_CONFIG();
  config.uri_match_fn = httpd_uri_match_wildcard;
  config.max_uri_handlers = 20;  // Increased for API endpoints
  config.max_open_sockets = 7;  // Allow more concurrent connections
  config.lru_purge_enable = true;  // Enable LRU purge for connection management
  config.stack_size = 8192;  // Increase stack size for handlers
  config.recv_wait_timeout = 10;  // Timeout for receiving data
  config.send_wait_timeout = 10;  // Timeout for sending data
  
  ESP_LOGI(TAG, "Starting HTTP server on port %d", config.server_port);
  
  if (httpd_start(&server, &config) == ESP_OK) {
    // API endpoints first (more specific routes)
    httpd_uri_t api_run_start_uri = {
      .uri       = "/api/run/start",
      .method    = HTTP_POST,
      .handler   = api_run_start_handler,
      .user_ctx  = NULL
    };
    httpd_register_uri_handler(server, &api_run_start_uri);

    httpd_uri_t api_run_stop_uri = {
      .uri       = "/api/run/stop",
      .method    = HTTP_POST,
      .handler   = api_run_stop_handler,
      .user_ctx  = NULL
    };
    httpd_register_uri_handler(server, &api_run_stop_uri);

    httpd_uri_t api_live_uri = {
      .uri       = "/api/live",
      .method    = HTTP_GET,
      .handler   = api_live_handler,
      .user_ctx  = NULL
    };
    httpd_register_uri_handler(server, &api_live_uri);
    
    httpd_uri_t api_runs_uri = {
      .uri       = "/api/runs",
      .method    = HTTP_GET,
      .handler   = api_runs_handler,
      .user_ctx  = NULL
    };
    httpd_register_uri_handler(server, &api_runs_uri);
    
    httpd_uri_t api_run_file_uri = {
      .uri       = "/api/runs/*",
      .method    = HTTP_GET,
      .handler   = api_run_file_handler,
      .user_ctx  = NULL
    };
    httpd_register_uri_handler(server, &api_run_file_uri);

    // Runners list
    httpd_uri_t api_runners_uri = {
      .uri       = "/api/runners",
      .method    = HTTP_GET,
      .handler   = api_runners_handler,
      .user_ctx  = NULL
    };
    httpd_register_uri_handler(server, &api_runners_uri);

    // Runs in folder
    httpd_uri_t api_runs_in_uri = {
      .uri       = "/api/runs-in",
      .method    = HTTP_GET,
      .handler   = api_runs_in_handler,
      .user_ctx  = NULL
    };
    httpd_register_uri_handler(server, &api_runs_in_uri);

    // Move run
    httpd_uri_t api_move_run_uri = {
      .uri       = "/api/move-run",
      .method    = HTTP_POST,
      .handler   = api_move_run_handler,
      .user_ctx  = NULL
    };
    httpd_register_uri_handler(server, &api_move_run_uri);

    httpd_uri_t api_create_runner_uri = {
      .uri       = "/api/create-runner",
      .method    = HTTP_POST,
      .handler   = api_create_runner_handler,
      .user_ctx  = NULL
    };
    httpd_register_uri_handler(server, &api_create_runner_uri);

    httpd_uri_t api_rename_run_uri = {
      .uri       = "/api/rename-run",
      .method    = HTTP_POST,
      .handler   = api_rename_run_handler,
      .user_ctx  = NULL
    };
    httpd_register_uri_handler(server, &api_rename_run_uri);

    httpd_uri_t api_delete_run_uri = {
      .uri       = "/api/delete-run",
      .method    = HTTP_POST,
      .handler   = api_delete_run_handler,
      .user_ctx  = NULL
    };
    httpd_register_uri_handler(server, &api_delete_run_uri);

    // Active runner GET/POST
    httpd_uri_t api_active_runner_get_uri = {
      .uri       = "/api/active-runner",
      .method    = HTTP_GET,
      .handler   = api_active_runner_get,
      .user_ctx  = NULL
    };
    httpd_register_uri_handler(server, &api_active_runner_get_uri);
    httpd_uri_t api_active_runner_post_uri = {
      .uri       = "/api/active-runner",
      .method    = HTTP_POST,
      .handler   = api_active_runner_post,
      .user_ctx  = NULL
    };
    httpd_register_uri_handler(server, &api_active_runner_post_uri);

    httpd_uri_t api_calibration_get_uri = {
      .uri       = "/api/calibration-mode",
      .method    = HTTP_GET,
      .handler   = api_calibration_get,
      .user_ctx  = NULL
    };
    httpd_register_uri_handler(server, &api_calibration_get_uri);

    httpd_uri_t api_calibration_post_uri = {
      .uri       = "/api/calibration-mode",
      .method    = HTTP_POST,
      .handler   = api_calibration_post,
      .user_ctx  = NULL
    };
    httpd_register_uri_handler(server, &api_calibration_post_uri);
    
    // Root handler
    httpd_uri_t root_uri = {
      .uri       = "/",
      .method    = HTTP_GET,
      .handler   = root_handler,
      .user_ctx  = NULL
    };
    httpd_register_uri_handler(server, &root_uri);
    
    // /ls handler
    httpd_uri_t ls_uri = {
      .uri       = "/ls",
      .method    = HTTP_GET,
      .handler   = ls_handler,
      .user_ctx  = NULL
    };
    httpd_register_uri_handler(server, &ls_uri);
    
    // /download handler
    httpd_uri_t download_uri = {
      .uri       = "/download",
      .method    = HTTP_GET,
      .handler   = download_handler,
      .user_ctx  = NULL
    };
    httpd_register_uri_handler(server, &download_uri);
    
    // Add favicon handler to prevent errors
    httpd_uri_t favicon_uri = {
      .uri       = "/favicon.ico",
      .method    = HTTP_GET,
      .handler   = static_handler,
      .user_ctx  = NULL
    };
    httpd_register_uri_handler(server, &favicon_uri);
    
    // Catch-all for static files (must be last)
    httpd_uri_t static_uri = {
      .uri       = "/*",
      .method    = HTTP_GET,
      .handler   = static_handler,
      .user_ctx  = NULL
    };
    httpd_register_uri_handler(server, &static_uri);
    
    return server;
  }
  
  ESP_LOGE(TAG, "Failed to start HTTP server");
  return NULL;
}

static void start_mdns_service(void)
{
    // Initialize mDNS service
    esp_err_t err = mdns_init();
    if (err) {
        ESP_LOGE(TAG, "MDNS Init failed: %d", err);
        return;
    }

    // Set hostname (this results in smartbike.local)
    mdns_hostname_set("smartbike");
    
    // Set default instance name
    mdns_instance_name_set("SmartBike Web Server");

    // Structure with TXT records (optional, but good for discovery apps)
    mdns_txt_item_t serviceTxtData[] = {
        {"board", "esp32"},
        {"u", "user"}
    };

    // Initialize the service: _http._tcp
    // This allows browsers to find the device
    ESP_ERROR_CHECK(mdns_service_add("SmartBike-WebServer", "_http", "_tcp", 80, serviceTxtData, 2));
    
    ESP_LOGI(TAG, "mDNS started. You can now access: http://smartbike.local");
}

void web_init(void) {
  // Initialize NVS (required for WiFi)
  esp_err_t ret = nvs_flash_init();
  if (ret == ESP_ERR_NVS_NO_FREE_PAGES || ret == ESP_ERR_NVS_NEW_VERSION_FOUND) {
    ESP_ERROR_CHECK(nvs_flash_erase());
    ret = nvs_flash_init();
  }
  ESP_ERROR_CHECK(ret);

  // Load persisted active runner
  nvs_load_active_runner();
  nvs_load_calibration_mode();

  // Initialize SPIFFS
  init_spiffs();
  
  // Initialize WiFi AP
  init_wifi_ap();

  // Start mDNS service for easy access
  start_mdns_service();
  
  // Start web server
  start_webserver();
  
  ESP_LOGI(TAG, "Web module initialized. WiFi AP '%s' at http://192.168.4.1/", AP_SSID);
}
