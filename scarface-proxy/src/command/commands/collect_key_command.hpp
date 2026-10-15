#pragma once
#include <string>
#include <string_view>

#include <fmt/format.h>

#include "../command.hpp"
#include "../command_registry.hpp"
#include "../../core/handlers/hotkey_handler.hpp"
#include "../../packet/packet_helper.hpp"
#include "../../packet/message/chat.hpp"

namespace command {
// "/collectkey [key]": shows or sets the key that toggles Auto Collect
// (e.g. /collectkey F6, /collectkey C). Also toggleable from the /proxy menu.
class CollectKeyCommand final : public ICommand {
public:
    explicit CollectKeyCommand(core::handlers::HotkeyHandler& handler)
        : handler_{ handler }
    {

    }

    [[nodiscard]] std::string_view name() const override { return "collectkey"; }
    [[nodiscard]] std::string description() const override { return "Show or set the Auto Collect toggle key"; }

    Result execute(const Context& ctx) override
    {
        if (ctx.args.empty()) {
            send_log(ctx, fmt::format(
                "Auto collect keybind is {}`` (key: `w{}``). Use ``{}collectkey <key>``",
                handler_.is_enabled() ? "`2ON" : "`4OFF",
                core::handlers::HotkeyHandler::name_from_key(handler_.get_key()),
                ctx.registry.prefix()
            ));
            return Result::Success;
        }

        const int vk{ core::handlers::HotkeyHandler::key_from_name(ctx.args[0]) };
        if (vk <= 0) {
            send_log(ctx, fmt::format("`4Unknown key ``{}`4. Try F1-F12, a letter or a digit.", ctx.args[0]));
            return Result::InvalidArguments;
        }

        handler_.set_key(vk);
        if (!handler_.is_enabled()) {
            handler_.set_enabled(true);
        }

        send_log(ctx, fmt::format(
            "Auto collect keybind `2ON`` - press `w{}`` to toggle auto collect",
            core::handlers::HotkeyHandler::name_from_key(vk)
        ));
        return Result::Success;
    }

private:
    static void send_log(const Context& ctx, const std::string& msg)
    {
        packet::message::Log log_pkt{};
        log_pkt.msg = msg;
        std::ignore = packet::PacketHelper::write(log_pkt, ctx.server);
    }

    core::handlers::HotkeyHandler& handler_;
};
}
