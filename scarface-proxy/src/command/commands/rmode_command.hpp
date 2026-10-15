#pragma once
#include <algorithm>
#include <cctype>
#include <string>
#include <string_view>

#include <fmt/format.h>

#include "../command.hpp"
#include "../command_registry.hpp"
#include "../../core/handlers/roulette_handler.hpp"
#include "../../packet/packet_helper.hpp"
#include "../../packet/message/chat.hpp"

namespace command {
// "/rmode [real|reme|qq]": shows or sets how roulette spins are annotated.
//   real -> the number itself       (27 -> 27)
//   reme -> sum of the two digits   (32 -> 5)
//   qq   -> the last digit          (27 -> 7)
class RmodeCommand final : public ICommand {
public:
    explicit RmodeCommand(core::handlers::RouletteHandler& handler)
        : handler_{ handler }
    {

    }

    [[nodiscard]] std::string_view name() const override { return "rmode"; }
    [[nodiscard]] std::string description() const override { return "Set roulette display mode: real, reme or qq"; }

    Result execute(const Context& ctx) override
    {
        if (ctx.args.empty()) {
            send_log(ctx, fmt::format(
                "Roulette mode: `w{}``. Use ``{}rmode <real|reme|qq>",
                handler_.mode_string(),
                ctx.registry.prefix()
            ));
            return Result::Success;
        }

        std::string arg{ ctx.args[0] };
        std::ranges::transform(arg, arg.begin(), [](const unsigned char c) { return std::tolower(c); });

        if (arg != "real" && arg != "reme" && arg != "qq") {
            send_log(ctx, fmt::format("`4Usage: ``{}rmode <real|reme|qq>", ctx.registry.prefix()));
            return Result::InvalidArguments;
        }

        handler_.set_mode_from_string(arg);
        send_log(ctx, fmt::format("Roulette mode set to `w{}", handler_.mode_string()));
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
