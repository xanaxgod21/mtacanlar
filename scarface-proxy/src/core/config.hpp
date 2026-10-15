#pragma once
#include <string>

namespace core {
class Config {
public:
    struct ServerConfig {
        int port{ 16999 };
        std::string address{ "www.growtopia1.com" };
    };

    struct ClientConfig {
        std::string game_version{ "5.39" };
        int protocol{ 225 };
        std::string dns_server{ "cloudflare" };
    };

    struct LogConfig {
        bool print_message{ true };
        bool print_game_update_packet{ false };
        bool print_variant{ true };
        bool print_extra{ true };
    };

    struct CommandConfig {
        char prefix{ '/' };
    };

    // Toggles changed with proxy commands; saved so they survive a restart.
    struct FeatureConfig {
        bool auto_collect{ false };
        float auto_collect_range{ 2.0f };
        bool roulette{ true };
        std::string roulette_mode{ "reme" };
        bool mod_alert{ true };
        bool quick_wrench{ false };
        std::string quick_wrench_action{ "pull" };
        bool fun_facts{ true };
        bool fast_drop{ false };
        int fast_drop_amount{ 0 };
        bool autocollect_keybind{ false };
        int autocollect_key{ 117 }; // Windows VK_F6
        bool pathfind{ false };
    };

    // Saved once the key is validated, so it is not asked for again.
    struct LicenseConfig {
        std::string key;
    };

    struct WrapperConfig {
        ServerConfig server;
        ClientConfig client;
        LogConfig log;
        CommandConfig command;
        FeatureConfig features;
        LicenseConfig license;
    };

public:
    Config();
    ~Config() = default;

public:
    [[nodiscard]] const ServerConfig& get_server_config() const { return config_.server; }
    [[nodiscard]] const ClientConfig& get_client_config() const { return config_.client; }
    [[nodiscard]] ClientConfig& get_client_config() { return config_.client; }
    [[nodiscard]] const LogConfig& get_log_config() const { return config_.log; }
    [[nodiscard]] const CommandConfig& get_command_config() const { return config_.command; }
    [[nodiscard]] const FeatureConfig& get_feature_config() const { return config_.features; }
    [[nodiscard]] FeatureConfig& get_feature_config() { return config_.features; }
    [[nodiscard]] const LicenseConfig& get_license_config() const { return config_.license; }
    [[nodiscard]] LicenseConfig& get_license_config() { return config_.license; }

    // Writes the current configuration to config.json. Returns false on failure.
    bool save() const;

private:
    WrapperConfig config_;
};
}
