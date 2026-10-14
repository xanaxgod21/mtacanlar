#pragma once
#include <chrono>
#include <functional>
#include <memory>
#include <optional>
#include <string>
#include <string_view>

#include "license.hpp"
#include "license_client.hpp"
#include "../core/scheduler.hpp"

namespace license {
// Set with the GTPROXY_LICENSE_SERVER and GTPROXY_LICENSE_PUBLIC_KEY CMake options.
#if defined(GTPROXY_LICENSE_SERVER) && defined(GTPROXY_LICENSE_PUBLIC_KEY)
inline constexpr bool ENABLED{ true };
inline constexpr std::string_view SERVER_URL{ GTPROXY_LICENSE_SERVER };
inline constexpr std::string_view PUBLIC_KEY{ GTPROXY_LICENSE_PUBLIC_KEY };
#else
inline constexpr bool ENABLED{ false };
inline constexpr std::string_view SERVER_URL{};
inline constexpr std::string_view PUBLIC_KEY{};
#endif

// A successful validation of a license key.
struct Activation {
    LicenseClient client;
    std::string key;
    Result result;
    std::chrono::steady_clock::time_point validated_at;
};

// Validates the key saved in config.json, or asks for one on stdin until a
// valid key is entered. Returns std::nullopt if the proxy must not start.
[[nodiscard]] std::optional<Activation> check_on_startup();

// Re-validates the key every 30 minutes on a scheduler worker thread and calls
// on_failure on the main thread once it is no longer valid. Network errors are
// tolerated for at most MAX_OFFLINE (so blocking the key server cannot keep a
// revoked or lifetime key running forever) and never past the signed expiry
// time. Create it with make_shared: pending checks keep it alive.
class LicenseMonitor final : public std::enable_shared_from_this<LicenseMonitor> {
public:
    static constexpr std::chrono::minutes CHECK_INTERVAL{ 30 };
    static constexpr std::chrono::hours MAX_OFFLINE{ 2 };

    LicenseMonitor(core::Scheduler& scheduler, Activation activation, std::function<void()> on_failure);

    void start();

private:
    void schedule_check(std::chrono::milliseconds delay);
    void on_result(const Result& result, std::chrono::steady_clock::time_point received_at);
    void update_deadline(const Result& result, std::chrono::steady_clock::time_point validated_at);
    void fail(std::string_view reason);

    [[nodiscard]] std::chrono::milliseconds next_delay(std::chrono::steady_clock::time_point now) const;

    core::Scheduler& scheduler_;
    const LicenseClient client_;
    const std::string key_;
    std::function<void()> on_failure_;

    // Main thread only. Measured with steady_clock from the last good
    // validation so changing the local clock does not extend the license;
    // std::nullopt for a lifetime license.
    std::optional<std::chrono::steady_clock::time_point> deadline_;
    // Main thread only. When the last successful validation was received.
    std::chrono::steady_clock::time_point last_ok_;
};
}
