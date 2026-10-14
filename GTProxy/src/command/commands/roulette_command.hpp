#pragma once
#include <algorithm>
#include <cctype>
#include <string>
#include <fmt/format.h>

#include "../command.hpp"
#include "../command_registry.hpp"
#include "../../core/handlers/roulette_handler.hpp"
#include "../../packet/packet_helper.hpp"
#include "../../packet/message/chat.hpp"

namespace command {
class RouletteCommand final : public ICommand {
public:
    explicit RouletteCommand(core::handlers::RouletteHandler& handler)
        : handler_{ handler }
    {

    }

    [[nodiscard]] std::string_view name() const override { return "roulette"; }
    [[nodiscard]] std::string description() const override { return "Show roulette results before the wheel stops"; }

    Result execute(const Context& ctx) override
    {
        std::string sub_cmd{ ctx.args.empty() ? "" : ctx.args[0] };
        std::ranges::transform(sub_cmd, sub_cmd.begin(), [](const unsigned char c) { return std::tolower(c); });

        if (sub_cmd.empty()) {
            handler_.set_enabled(!handler_.is_enabled());
        }
        else if (sub_cmd == "on" || sub_cmd == "off") {
            handler_.set_enabled(sub_cmd == "on");
        }
        else if (sub_cmd != "status") {
            send_log(ctx, fmt::format("`4Usage: ``{}roulette [on|off|status]", ctx.registry.prefix()));
            return Result::InvalidArguments;
        }

        send_log(ctx, fmt::format("Early roulette results {}", handler_.is_enabled() ? "`2ON" : "`4OFF"));
        return Result::Success;
    }

private:
    static void send_log(const Context& ctx, const std::string& msg)
    {
        packet::message::Log log_pkt{};
        log_pkt.msg = msg;
        std::ignore = packet::PacketHelper::write(log_pkt, ctx.server);
    }

    core::handlers::RouletteHandler& handler_;
};
}
