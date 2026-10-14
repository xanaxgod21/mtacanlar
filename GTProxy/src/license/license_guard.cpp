#include "license_guard.hpp"

#include <algorithm>
#include <iostream>
#include <tuple>
#include <utility>
#include <fmt/chrono.h>
#include <fmt/format.h>
#include <spdlog/spdlog.h>

#include "../core/branding.hpp"
#include "../core/config.hpp"

namespace license {
namespace {
// Caps the time left on a license so the steady_clock deadline cannot overflow.
constexpr std::chrono::seconds MAX_REMAINING{ std::chrono::years{ 100 } };
constexpr std::chrono::milliseconds MIN_CHECK_DELAY{ 1000 };

[[nodiscard]] std::optional<std::string> prompt_key()
{
    std::cout << "Enter your license key: " << std::flush;

    std::string line{};
    if (!std::getline(std::cin, line)) {
        std::cout << std::endl;
        return std::nullopt;
    }

    return line;
}

[[nodiscard]] std::string format_expiry(const std::int64_t expires_at)
{
    const std::chrono::sys_seconds time{ std::chrono::seconds{ expires_at } };
    return fmt::format("{:%Y-%m-%d %H:%M} UTC", time);
}
}

std::optional<Activation> check_on_startup()
{
    const auto machine_id{ read_machine_id() };
    const auto hwid{ machine_id ? make_hwid(*machine_id) : std::nullopt };
    if (!hwid) {
        spdlog::error("Could not read the machine ID of this computer, the license cannot be checked");
        return std::nullopt;
    }

    LicenseClient client{ std::string{ SERVER_URL }, std::string{ PUBLIC_KEY }, *hwid };

    core::Config config{};
    auto& saved_key{ config.get_license_config().key };
    std::string key{ normalize_key(saved_key) };

    while (true) {
        if (key.empty()) {
            const auto input{ prompt_key() };
            if (!input) {
                spdlog::error("No license key entered");
                return std::nullopt;
            }

            key = normalize_key(*input);
            continue;
        }

        spdlog::info("Checking license key...");
        auto result{ client.activate(key) };
        const auto validated_at{ std::chrono::steady_clock::now() };

        if (result.status == Status::Ok) {
            if (saved_key != key) {
                saved_key = key;
                std::ignore = config.save();
            }

            if (result.expires_at == 0) {
                spdlog::info("License valid (lifetime)");
            }
            else {
                spdlog::info("License valid until {}", format_expiry(result.expires_at));
            }

            spdlog::info("Hardware ID: {}", format_hwid(client.get_hwid()));
            return Activation{ std::move(client), std::move(key), std::move(result), validated_at };
        }

        if (!is_rejection(result.status)) {
            // May be temporary, so the saved key is kept for the next start.
            spdlog::error("License check failed: {}", result.message);
            return std::nullopt;
        }

        spdlog::error("License key rejected: {}", result.message);
        if (result.status == Status::HwidMismatch) {
            spdlog::info("Hardware ID of this computer: {}", format_hwid(client.get_hwid()));
        }

        if (!saved_key.empty()) {
            saved_key.clear();
            std::ignore = config.save();
        }

        key.clear();
    }
}

LicenseMonitor::LicenseMonitor(core::Scheduler& scheduler, Activation activation, std::function<void()> on_failure)
    : scheduler_{ scheduler }
    , client_{ std::move(activation.client) }
    , key_{ std::move(activation.key) }
    , on_failure_{ std::move(on_failure) }
    , last_ok_{ activation.validated_at }
{
    update_deadline(activation.result, activation.validated_at);
}

void LicenseMonitor::start()
{
    schedule_check(next_delay(std::chrono::steady_clock::now()));
}

void LicenseMonitor::schedule_check(const std::chrono::milliseconds delay)
{
    // The request runs on a worker thread so it never blocks the ENet loop;
    // the result is handled on the main thread.
    scheduler_.schedule_delayed([self = shared_from_this()] {
        auto result{ self->client_.activate(self->key_) };
        const auto received_at{ std::chrono::steady_clock::now() };

        self->scheduler_.post_to_main_thread([self, result = std::move(result), received_at] {
            self->on_result(result, received_at);
        });
    }, delay, "license");
}

void LicenseMonitor::on_result(const Result& result, const std::chrono::steady_clock::time_point received_at)
{
    const auto now{ std::chrono::steady_clock::now() };

    if (result.status == Status::Ok) {
        update_deadline(result, received_at);
        last_ok_ = received_at;
        spdlog::debug("License re-validated");
    }
    else if (is_rejection(result.status) || result.status == Status::BadSignature) {
        fail(result.message);
        return;
    }
    else if (now - last_ok_ >= MAX_OFFLINE) {
        fail(fmt::format("could not reach the license server for {} hours ({})", MAX_OFFLINE.count(), result.message));
        return;
    }
    else {
        spdlog::warn("License check failed, retrying later: {}", result.message);
    }

    if (deadline_ && now >= *deadline_) {
        fail(describe(Status::Expired));
        return;
    }

    schedule_check(next_delay(now));
}

void LicenseMonitor::update_deadline(const Result& result, const std::chrono::steady_clock::time_point validated_at)
{
    if (result.expires_at == 0) {
        deadline_.reset();
        return;
    }

    const std::chrono::seconds remaining{
        std::clamp<std::int64_t>(result.expires_at - result.server_time, 0, MAX_REMAINING.count())
    };
    deadline_ = validated_at + remaining;
}

void LicenseMonitor::fail(const std::string_view reason)
{
    // Server messages end with a period, the local ones do not.
    spdlog::error("License is no longer valid, stopping {}: {}", core::branding::PRODUCT_NAME, reason);
    on_failure_();
}

std::chrono::milliseconds LicenseMonitor::next_delay(const std::chrono::steady_clock::time_point now) const
{
    if (!deadline_) {
        return CHECK_INTERVAL;
    }

    // Check again right when the license expires if that comes first.
    const auto until_deadline{ std::chrono::ceil<std::chrono::milliseconds>(*deadline_ - now) };
    return std::clamp(until_deadline, MIN_CHECK_DELAY, std::chrono::milliseconds{ CHECK_INTERVAL });
}
}
