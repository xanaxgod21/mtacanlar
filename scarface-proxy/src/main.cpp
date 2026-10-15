#include <csignal>
#include <string>
#include <spdlog/spdlog.h>

#ifdef _WIN32
#include <windows.h>
#endif

#include "core/branding.hpp"
#include "core/core.hpp"
#include "core/logger.hpp"
#include "license/license_guard.hpp"

std::unique_ptr<core::Core> g_core{ nullptr };

void signal_handler(int signal)
{
    if (!g_core) {
        return;
    }

    spdlog::info("Interrupted by signal {}, stopping...", signal);
    g_core->stop();
}

int main()
{
#ifdef _WIN32
    SetConsoleTitleA(std::string{ core::branding::PRODUCT_NAME }.c_str());
#endif

    try {
        core::Logger logger{};

        std::vector<spdlog::sink_ptr> sinks{
            core::Logger::create_console_sink(),
            core::Logger::create_file_sink()
        };

        logger.set_logger(std::make_shared<spdlog::logger>("ScarfaceProxy", sinks.begin(), sinks.end()));
        logger.get_logger()->set_level(spdlog::level::trace);

        spdlog::register_logger(logger.get_logger());
        spdlog::set_default_logger(logger.get_logger());
        spdlog::set_pattern("[%Y-%m-%d %H:%M:%S.%e] [%t] [%^%l%$] %v");
    }
    catch (const spdlog::spdlog_ex& ex) {
        spdlog::error("Log initialization failed: {}", ex.what());
        return 1;
    }

    int exit_code{ 0 };
    try {
        spdlog::info(
            "Starting {} (v{}.{}.{}{})",
            core::branding::PRODUCT_NAME,
            GTPROXY_VERSION_MAJOR,
            GTPROXY_VERSION_MINOR,
            GTPROXY_VERSION_PATCH,
#ifdef GTPROXY_BUILD_VERSION
            fmt::format("-{}", GTPROXY_BUILD_VERSION)
#else
            ""
#endif
        );

        std::optional<license::Activation> activation{};
        if constexpr (license::ENABLED) {
            activation = license::check_on_startup();
            if (!activation) {
                return 1;
            }
        }
        else {
            spdlog::warn("License check disabled in this build");
        }

        g_core = std::make_unique<core::Core>();

        std::shared_ptr<license::LicenseMonitor> license_monitor{};
        if (activation) {
            license_monitor = std::make_shared<license::LicenseMonitor>(
                g_core->get_scheduler(),
                std::move(*activation),
                [] { g_core->stop(); }
            );
            license_monitor->start();
        }

        std::signal(SIGINT, signal_handler);
        std::signal(SIGTERM, signal_handler);

        g_core->run();
    }
    catch (const std::runtime_error& e) {
        spdlog::error("Runtime error: {}", e.what());
        exit_code = 1;
    }
    catch (const std::exception& ex) {
        spdlog::error("Exception: {}", ex.what());
        exit_code = 1;
    }

    // Destroy the core while logging still works: its scheduler logs when it
    // stops. Left to static destruction it ran after spdlog::shutdown() and crashed.
    g_core.reset();

    spdlog::info("{} stopped", core::branding::PRODUCT_NAME);
    spdlog::shutdown();
    return exit_code;
}
