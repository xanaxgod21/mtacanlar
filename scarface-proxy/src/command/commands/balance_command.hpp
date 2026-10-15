#pragma once
#include <string>
#include <fmt/format.h>

#include "../command.hpp"
#include "../../item/locks.hpp"
#include "../../packet/packet_helper.hpp"
#include "../../packet/message/chat.hpp"
#include "../../player/inventory.hpp"

namespace command {
class BalanceCommand final : public ICommand {
public:
    [[nodiscard]] std::string_view name() const override { return "balance"; }
    [[nodiscard]] std::string description() const override { return "Show how many locks you have"; }

    Result execute(const Context& ctx) override
    {
        const auto& inventory{ player::Inventory::instance() };
        if (!inventory.is_known()) {
            send_log(ctx, "`4Inventory not received yet. ``It is sent when you log in through the proxy.");
            return Result::Failed;
        }

        const int world_locks{ inventory.get(item::locks::WORLD_LOCK) };
        const int diamond_locks{ inventory.get(item::locks::DIAMOND_LOCK) };
        const int blue_gem_locks{ inventory.get(item::locks::BLUE_GEM_LOCK) };

        send_log(ctx, fmt::format(
            "Balance: `w{}`` WL, `1{}`` DL, `e{}`` BGL = `2{}`` WL total",
            world_locks,
            diamond_locks,
            blue_gem_locks,
            item::locks::value_in_world_locks(world_locks, diamond_locks, blue_gem_locks)
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
};
}
