#pragma once
#include <chrono>
#include <cstdint>
#include <deque>
#include <string>
#include <string_view>
#include <vector>

#include "../config.hpp"
#include "../../event/event.hpp"
#include "../../network/server.hpp"

namespace core::handlers {
// The server sends a roulette result as soon as the wheel is punched, but with a
// display delay so the game shows it after the spin animation. This shows the
// number to the player the moment it arrives. Only delayed messages count:
// a player typing "spun the wheel" in chat has no delay, so fakes are not echoed.
class RouletteHandler {
public:
    RouletteHandler(event::Dispatcher& dispatcher, network::Server& server, Config& config);

    RouletteHandler(const RouletteHandler&) = delete;
    RouletteHandler& operator=(const RouletteHandler&) = delete;
    RouletteHandler(RouletteHandler&&) noexcept = delete;
    RouletteHandler& operator=(RouletteHandler&&) noexcept = delete;
    ~RouletteHandler() = default;

    struct SpinRecord {
        std::string spinner;
        int number{ 0 };
        std::string color_code;
        std::chrono::steady_clock::time_point time{};
    };

    static constexpr std::size_t MAX_HISTORY{ 20 };

    [[nodiscard]] bool is_enabled() const { return enabled_; }
    void set_enabled(bool enabled);

    // How a spin result is annotated next to every player's spin.
    //   Real -> the number itself     (27 -> 27)
    //   Reme -> sum of the two digits (32 -> 5)
    //   Qq   -> the last digit        (27 -> 7)
    enum class Mode { Real, Reme, Qq };

    [[nodiscard]] Mode get_mode() const { return mode_; }
    void set_mode(Mode mode);
    void set_mode_from_string(std::string_view name); // Unknown names are ignored.
    [[nodiscard]] std::string_view mode_string() const { return mode_to_string(mode_); }
    [[nodiscard]] static std::string_view mode_to_string(Mode mode);
    [[nodiscard]] static Mode mode_from_string(std::string_view name); // Defaults to Reme.

    // Real spins seen in the current world, newest first.
    [[nodiscard]] const std::deque<SpinRecord>& get_history() const { return history_; }

private:
    // The talk bubble and the console message of one spin arrive together;
    // show the result once.
    static constexpr auto DUPLICATE_WINDOW{ std::chrono::milliseconds{ 1000 } };

    template <packet::PacketId Id, typename Packet>
    void listen();
    void on_message(std::string_view text, std::int32_t delay);
    void send_to_player(packet::IPacket& packet) const;

    event::Dispatcher& dispatcher_;
    network::Server& server_;
    Config& config_;

    bool enabled_{ true };
    Mode mode_{ Mode::Reme };
    std::deque<SpinRecord> history_;
    std::string last_spin_key_;
    std::chrono::steady_clock::time_point last_spin_time_{};

    std::vector<event::ScopedHandle> handles_;
};
}
