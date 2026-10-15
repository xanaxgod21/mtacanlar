#pragma once
#include <algorithm>
#include <cctype>
#include <string>
#include <fmt/format.h>

#include "../command.hpp"
#include "../command_registry.hpp"
#include "../../core/handlers/quick_wrench_handler.hpp"
#include "../../core/handlers/world_manage_handler.hpp"
#include "../../packet/packet_helper.hpp"
#include "../../packet/message/chat.hpp"

namespace command {
// "/wrench [on|off|status|pull|kick|ban]": act on a player the instant you
// wrench them, with no menu. on/off (or no argument) toggle it; pull (aliases
// "cek"/"çek"), kick and ban pick which action a wrench performs.
class WrenchCommand final : public ICommand {
public:
    using Action = core::handlers::QuickWrenchHandler::Action;

    explicit WrenchCommand(core::handlers::QuickWrenchHandler& handler)
        : handler_{ handler }
    {

    }

    [[nodiscard]] std::string_view name() const override { return "wrench"; }
    [[nodiscard]] std::string description() const override
    {
        return "Instantly pull/kick/ban a player when you wrench them";
    }

    Result execute(const Context& ctx) override
    {
        if (ctx.args.empty()) {
            handler_.set_enabled(!handler_.is_enabled());
            send_status(ctx);
            return Result::Success;
        }

        std::string sub_cmd{ ctx.args[0] };
        std::ranges::transform(sub_cmd, sub_cmd.begin(), [](const unsigned char c) { return std::tolower(c); });

        if (sub_cmd == "on") {
            handler_.set_enabled(true);
            send_status(ctx);
            return Result::Success;
        }

        if (sub_cmd == "off") {
            handler_.set_enabled(false);
            send_status(ctx);
            return Result::Success;
        }

        if (sub_cmd == "status") {
            send_status(ctx);
            return Result::Success;
        }

        if (sub_cmd == "pull" || sub_cmd == "cek" || sub_cmd == "çek") {
            handler_.set_action(Action::Pull);
            send_status(ctx);
            return Result::Success;
        }

        if (sub_cmd == "kick") {
            handler_.set_action(Action::Kick);
            send_status(ctx);
            return Result::Success;
        }

        if (sub_cmd == "ban") {
            handler_.set_action(Action::Ban);
            send_status(ctx);
            return Result::Success;
        }

        send_log(ctx, fmt::format("`4Usage: ``{}wrench [on|off|status|pull|kick|ban]", ctx.registry.prefix()));
        return Result::InvalidArguments;
    }

private:
    void send_status(const Context& ctx) const
    {
        send_log(ctx, fmt::format(
            "Quick wrench is {}`` (action: `w{}``)",
            handler_.is_enabled() ? "`2ON" : "`4OFF",
            core::handlers::WorldManageHandler::action_name(handler_.get_action())
        ));
    }

    static void send_log(const Context& ctx, const std::string& msg)
    {
        packet::message::Log log_pkt{};
        log_pkt.msg = msg;
        std::ignore = packet::PacketHelper::write(log_pkt, ctx.server);
    }

    core::handlers::QuickWrenchHandler& handler_;
};
}
