#pragma once
#include <algorithm>
#include <cctype>
#include <charconv>
#include <string>
#include <fmt/format.h>

#include "../command.hpp"
#include "../command_registry.hpp"
#include "../../core/handlers/auto_collect_handler.hpp"
#include "../../packet/packet_helper.hpp"
#include "../../packet/message/chat.hpp"

namespace command {
class AutoCollectCommand final : public ICommand {
public:
    explicit AutoCollectCommand(core::handlers::AutoCollectHandler& handler)
        : handler_{ handler }
    {

    }

    [[nodiscard]] std::string_view name() const override { return "autocollect"; }
    [[nodiscard]] std::string description() const override { return "Automatically pick up nearby dropped items"; }

    Result execute(const Context& ctx) override
    {
        if (ctx.args.empty()) {
            set_enabled(ctx, !handler_.is_enabled());
            return Result::Success;
        }

        std::string sub_cmd{ ctx.args[0] };
        std::ranges::transform(sub_cmd, sub_cmd.begin(), [](const unsigned char c) { return std::tolower(c); });

        if (sub_cmd == "on") {
            set_enabled(ctx, true);
            return Result::Success;
        }

        if (sub_cmd == "off") {
            set_enabled(ctx, false);
            return Result::Success;
        }

        if (sub_cmd == "status") {
            send_log(ctx, fmt::format(
                "Auto collect is {}`` (range: {:.1f} tiles)",
                handler_.is_enabled() ? "`2ON" : "`4OFF",
                handler_.get_range()
            ));
            return Result::Success;
        }

        if (sub_cmd == "range") {
            float range{ 0.0f };
            const std::string arg{ ctx.args.size() > 1 ? ctx.args[1] : "" };
            if (
                auto [ptr, ec]{ std::from_chars(arg.data(), arg.data() + arg.size(), range) };
                arg.empty() || ec != std::errc{} || ptr != arg.data() + arg.size()
            ) {
                send_log(ctx, fmt::format(
                    "`4Usage: ``{}autocollect range <{:.0f}-{:.0f}>",
                    ctx.registry.prefix(),
                    core::handlers::AutoCollectHandler::MIN_RANGE,
                    core::handlers::AutoCollectHandler::MAX_RANGE
                ));
                return Result::InvalidArguments;
            }

            send_log(ctx, fmt::format("Auto collect range set to {:.1f} tiles", handler_.set_range(range)));
            return Result::Success;
        }

        send_log(ctx, fmt::format("`4Usage: ``{}autocollect [on|off|status|range <tiles>]", ctx.registry.prefix()));
        return Result::InvalidArguments;
    }

private:
    void set_enabled(const Context& ctx, const bool enabled)
    {
        handler_.set_enabled(enabled);
        if (!enabled) {
            send_log(ctx, "Auto collect `4disabled");
            return;
        }

        send_log(ctx, fmt::format("Auto collect `2enabled`` (range: {:.1f} tiles)", handler_.get_range()));
        handler_.collect_nearby();
    }

    static void send_log(const Context& ctx, const std::string& msg)
    {
        packet::message::Log log_pkt{};
        log_pkt.msg = msg;
        std::ignore = packet::PacketHelper::write(log_pkt, ctx.server);
    }

    core::handlers::AutoCollectHandler& handler_;
};
}
