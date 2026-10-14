#pragma once
#include <algorithm>
#include <cctype>
#include <functional>
#include <string>
#include <fmt/format.h>

#include "../command.hpp"
#include "../command_registry.hpp"
#include "../../packet/packet_helper.hpp"
#include "../../packet/message/chat.hpp"

namespace command {
// "/<name> [on|off|status]" for a feature that can be switched on and off;
// without an argument it toggles.
class ToggleCommand final : public ICommand {
public:
    ToggleCommand(
        std::string name,
        std::string description,
        std::string feature_label,
        std::function<bool()> is_enabled,
        std::function<void(bool)> set_enabled
    )
        : name_{ std::move(name) }
        , description_{ std::move(description) }
        , feature_label_{ std::move(feature_label) }
        , is_enabled_{ std::move(is_enabled) }
        , set_enabled_{ std::move(set_enabled) }
    {

    }

    [[nodiscard]] std::string_view name() const override { return name_; }
    [[nodiscard]] std::string description() const override { return description_; }

    Result execute(const Context& ctx) override
    {
        std::string sub_cmd{ ctx.args.empty() ? "" : ctx.args[0] };
        std::ranges::transform(sub_cmd, sub_cmd.begin(), [](const unsigned char c) { return std::tolower(c); });

        if (sub_cmd.empty()) {
            set_enabled_(!is_enabled_());
        }
        else if (sub_cmd == "on" || sub_cmd == "off") {
            set_enabled_(sub_cmd == "on");
        }
        else if (sub_cmd != "status") {
            send_log(ctx, fmt::format("`4Usage: ``{}{} [on|off|status]", ctx.registry.prefix(), name_));
            return Result::InvalidArguments;
        }

        send_log(ctx, fmt::format("{} {}", feature_label_, is_enabled_() ? "`2ON" : "`4OFF"));
        return Result::Success;
    }

private:
    static void send_log(const Context& ctx, const std::string& msg)
    {
        packet::message::Log log_pkt{};
        log_pkt.msg = msg;
        std::ignore = packet::PacketHelper::write(log_pkt, ctx.server);
    }

    std::string name_;
    std::string description_;
    std::string feature_label_;
    std::function<bool()> is_enabled_;
    std::function<void(bool)> set_enabled_;
};
}
