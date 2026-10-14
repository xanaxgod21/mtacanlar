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
        bool mod_alert{ true };
    };

    struct WrapperConfig {
        ServerConfig server;
        ClientConfig client;
        LogConfig log;
        CommandConfig command;
        FeatureConfig features;
    };

public:
    Config();
    ~Config() = default;

public:
    [[nodiscard]] const ServerConfig& get_server_config() const { return config_.server; }
    [[nodiscard]] const ClientConfig& get_client_config() const { return config_.client; }
    [[nodiscard]] const LogConfig& get_log_config() const { return config_.log; }
    [[nodiscard]] const CommandConfig& get_command_config() const { return config_.command; }
    [[nodiscard]] const FeatureConfig& get_feature_config() const { return config_.features; }
    [[nodiscard]] FeatureConfig& get_feature_config() { return config_.features; }

    // Writes the current configuration to config.json. Returns false on failure.
    bool save() const;

private:
    WrapperConfig config_;
};
}
