#pragma once
#include <algorithm>
#include <charconv>
#include <chrono>
#include <string>
#include <fmt/format.h>

#include "../command.hpp"
#include "../../core/handlers/roulette_handler.hpp"
#include "../../packet/packet_helper.hpp"
#include "../../packet/message/chat.hpp"
#include "../../utils/roulette.hpp"

namespace command {
class SpinsCommand final : public ICommand {
public:
    explicit SpinsCommand(const core::handlers::RouletteHandler& handler)
        : handler_{ handler }
    {

    }

    [[nodiscard]] std::string_view name() const override { return "spins"; }
    [[nodiscard]] std::string description() const override { return "Show the last roulette spins in this world"; }

    Result execute(const Context& ctx) override
    {
        constexpr std::size_t default_count{ 10 };
        std::size_t count{ default_count };
        if (!ctx.args.empty()) {
            const auto& arg{ ctx.args[0] };
            std::from_chars(arg.data(), arg.data() + arg.size(), count);
        }

        const auto& history{ handler_.get_history() };
        if (history.empty()) {
            send_log(ctx, "No spins seen in this world yet");
            return Result::Success;
        }

        count = std::clamp<std::size_t>(count, 1, core::handlers::RouletteHandler::MAX_HISTORY);
        count = std::min(count, history.size());

        send_log(ctx, fmt::format("Last {} spins (newest first):", count));
        const auto now{ std::chrono::steady_clock::now() };
        for (std::size_t i{ 0 }; i < count; ++i) {
            const auto& spin{ history[i] };
            const auto seconds_ago{ std::chrono::duration_cast<std::chrono::seconds>(now - spin.time).count() };
            send_log(ctx, fmt::format(
                "`w{}`` {}{}`` `o(reme {}) {}s ago``",
                spin.spinner,
                spin.color_code,
                spin.number,
                utils::roulette::reme(spin.number),
                seconds_ago
            ));
        }

        return Result::Success;
    }

private:
    static void send_log(const Context& ctx, const std::string& msg)
    {
        packet::message::Log log_pkt{};
        log_pkt.msg = msg;
        std::ignore = packet::PacketHelper::write(log_pkt, ctx.server);
    }

    const core::handlers::RouletteHandler& handler_;
};
}
