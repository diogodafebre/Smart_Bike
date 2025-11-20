// Minimal AP (open) + SPIFFS static web server - ESP-IDF version
#include <string.h>
#include <sys/param.h>
#include <sys/stat.h>
#include <dirent.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "esp_wifi.h"
#include "esp_event.h"
#include "esp_log.h"
#include "esp_spiffs.h"
#include "esp_http_server.h"
#include "nvs_flash.h"
#include "esp_mac.h"
#include "shared.h"  // Access to sensor data

static const char* TAG = "SmartBike";
static const char* AP_SSID = "SmartBike"; // open AP (no password)
static httpd_handle_t server = NULL;

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

// Stream file with proper headers
static esp_err_t streamFile(httpd_req_t *req, const char* filepath, bool isGz) {
  FILE* f = fopen(filepath, "r");
  if (!f) {
    ESP_LOGE(TAG, "Failed to open file: %s", filepath);
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
  return ESP_OK;
}

// Check if file exists
static bool fileExists(const char* path) {
  struct stat st;
  return (stat(path, &st) == 0);
}

// Serve a file from SPIFFS
static esp_err_t serveFile(httpd_req_t *req, const char* uri) {
  char filepath[256];
  
  // Build filesystem path
  if (strcmp(uri, "/") == 0) {
    snprintf(filepath, sizeof(filepath), "/spiffs/index.html");
  } else {
    snprintf(filepath, sizeof(filepath), "/spiffs%s", uri);
  }

  // 1) Try exact file
  if (fileExists(filepath)) {
    bool isGz = endsWith(filepath, ".gz");
    return streamFile(req, filepath, isGz);
  }

  // 2) Try gzip version
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
  char query[256];
  if (httpd_req_get_url_query_str(req, query, sizeof(query)) != ESP_OK) {
    httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "missing f param");
    return ESP_FAIL;
  }
  
  char param[128];
  if (httpd_query_key_value(query, "f", param, sizeof(param)) != ESP_OK) {
    httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "missing f param");
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
    return ESP_FAIL;
  }
  
  FILE* f = fopen(filepath, "r");
  if (!f) {
    httpd_resp_send_err(req, HTTPD_500_INTERNAL_SERVER_ERROR, "open failed");
    return ESP_FAIL;
  }
  
  httpd_resp_set_type(req, "application/octet-stream");
  
  char buf[1024];
  while (!feof(f)) {
    size_t n = fread(buf, 1, sizeof(buf), f);
    if (n > 0) {
      if (httpd_resp_send_chunk(req, buf, n) != ESP_OK) {
        fclose(f);
        return ESP_FAIL;
      }
    }
    vTaskDelay(pdMS_TO_TICKS(1));
  }
  httpd_resp_send_chunk(req, NULL, 0);
  fclose(f);
  return ESP_OK;
}

// API endpoint: /api/live - Returns current ADC sensor data as JSON
static esp_err_t api_live_handler(httpd_req_t *req) {
  char json[512];
  
  // Build JSON with all 8 sensor values
  int len = snprintf(json, sizeof(json),
    "{\"timestamp\":%lu,\"active\":%s,\"run_id\":%d,\"sensors\":["
    "%.4f,%.4f,%.4f,%.4f,%.4f,%.4f,%.4f,%.4f]}",
    (unsigned long)g_latest_sensor_data.timestamp_ms,
    g_run_active ? "true" : "false",
    g_run_id,
    g_latest_sensor_data.voltages[0],
    g_latest_sensor_data.voltages[1],
    g_latest_sensor_data.voltages[2],
    g_latest_sensor_data.voltages[3],
    g_latest_sensor_data.voltages[4],
    g_latest_sensor_data.voltages[5],
    g_latest_sensor_data.voltages[6],
    g_latest_sensor_data.voltages[7]
  );
  
  httpd_resp_set_type(req, "application/json");
  httpd_resp_set_hdr(req, "Access-Control-Allow-Origin", "*");
  httpd_resp_send(req, json, len);
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
      // Check if it's a RUN*.CSV file
      if (strstr(entry->d_name, "RUN") == entry->d_name && 
          strstr(entry->d_name, ".CSV") != NULL) {
        if (!first) strcat(json, ",");
        strcat(json, "\"");
        strcat(json, entry->d_name);
        strcat(json, "\"");
        first = false;
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

// API endpoint: /api/runs/<filename> - Download a specific RUN file from SD
static esp_err_t api_run_file_handler(httpd_req_t *req) {
  // Extract filename from URI (e.g., /api/runs/RUN1.CSV)
  const char* uri = req->uri;
  const char* filename = strrchr(uri, '/');
  if (!filename || strlen(filename) <= 1) {
    httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "Invalid filename");
    return ESP_FAIL;
  }
  filename++; // Skip the '/'
  
  char filepath[256];
  snprintf(filepath, sizeof(filepath), "/sdcard/%s", filename);
  
  FILE* f = fopen(filepath, "r");
  if (!f) {
    httpd_resp_send_err(req, HTTPD_404_NOT_FOUND, "File not found");
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
        return ESP_FAIL;
      }
    }
  }
  httpd_resp_send_chunk(req, NULL, 0);
  fclose(f);
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
  } else if (event_id == WIFI_EVENT_AP_STADISCONNECTED) {
    wifi_event_ap_stadisconnected_t* event = (wifi_event_ap_stadisconnected_t*) event_data;
    ESP_LOGI(TAG, "Station " MACSTR " left, AID=%d",
             MAC2STR(event->mac), event->aid);
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

  ESP_LOGI(TAG, "WiFi AP started. SSID: %s", AP_SSID);
  ESP_LOGI(TAG, "AP IP: 192.168.4.1");
}

// Start HTTP server
static httpd_handle_t start_webserver(void) {
  httpd_config_t config = HTTPD_DEFAULT_CONFIG();
  config.uri_match_fn = httpd_uri_match_wildcard;
  config.max_uri_handlers = 16;  // Increased for API endpoints
  config.max_open_sockets = 7;  // Allow more concurrent connections
  config.lru_purge_enable = true;  // Enable LRU purge for connection management
  config.stack_size = 8192;  // Increase stack size for handlers
  config.recv_wait_timeout = 10;  // Timeout for receiving data
  config.send_wait_timeout = 10;  // Timeout for sending data
  
  ESP_LOGI(TAG, "Starting HTTP server on port %d", config.server_port);
  
  if (httpd_start(&server, &config) == ESP_OK) {
    // API endpoints first (more specific routes)
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

void web_init(void) {
  // Initialize NVS (required for WiFi)
  esp_err_t ret = nvs_flash_init();
  if (ret == ESP_ERR_NVS_NO_FREE_PAGES || ret == ESP_ERR_NVS_NEW_VERSION_FOUND) {
    ESP_ERROR_CHECK(nvs_flash_erase());
    ret = nvs_flash_init();
  }
  ESP_ERROR_CHECK(ret);

  // Initialize SPIFFS
  init_spiffs();
  
  // Initialize WiFi AP
  init_wifi_ap();
  
  // Start web server
  start_webserver();
  
  ESP_LOGI(TAG, "Web module initialized. WiFi AP '%s' at http://192.168.4.1/", AP_SSID);
}
