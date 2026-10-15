#pragma once
#include <string>
#include <vector>
#include <fmt/format.h>

#include "../command.hpp"
#include "../command_registry.hpp"
#include "../../core/handlers/world_manage_handler.hpp"
#include "../../packet/packet_helper.hpp"
#include "../../packet/message/chat.hpp"
#include "../../world/player_finder.hpp"
#include "../../world/world.hpp"

namespace command {
// "/pull <name>", "/kick <name>" and "/ban <name>" for players in your world.
class WorldActionCommand final : public ICommand {
public:
    using Action = core::handlers::WorldManageHandler::Action;

    WorldActionCommand(const Action action, core::handlers::WorldManageHandler& handler)
        : action_{ action }
        , name_{ core::handlers::WorldManageHandler::action_name(action) }
        , handler_{ handler }
    {

    }

    [[nodiscard]] std::string_view name() const override { return name_; }
    [[nodiscard]] std::string description() const override { return fmt::format("{} a player in your world", name_); }

    Result execute(const Context& ctx) override
    {
        if (ctx.args.empty()) {
            send_log(ctx, fmt::format("`4Usage: ``{}{} <player name>", ctx.registry.prefix(), name_));
            return Result::InvalidArguments;
        }

        const auto& world{ world::World::instance() };
        const auto matches{ world::find_players_by_name(world.get_players(), ctx.args[0], world.get_local_net_id()) };

        if (matches.empty()) {
            send_log(ctx, fmt::format("`4No player named ``{}`4 in this world", ctx.args[0]));
            return Result::Failed;
        }

        if (matches.size() > 1) {
            std::string names{};
            for (const auto& match : matches) {
                names += (names.empty() ? "" : ", ") + match.name;
            }

            send_log(ctx, fmt::format("`4More than one player matches ``{}`4: ``{}", ctx.args[0], names));
            return Result::Failed;
        }

        const auto& target{ matches.front() };
        switch (handler_.request(action_, target.net_id, target.name)) {
        case core::handlers::WorldManageHandler::Result::Sent:
            send_log(ctx, fmt::format("Trying to {} `w{}``...", name_, target.name));
            return Result::Success;
        case core::handlers::WorldManageHandler::Result::NotInWorld:
            send_log(ctx, "`4Error: ``You are not in a world");
            return Result::Failed;
        case core::handlers::WorldManageHandler::Result::NotConnected:
            send_log(ctx, "`4Error: ``Not connected to the server");
            return Result::Failed;
        }

        return Result::Failed;
    }

private:
    static void send_log(const Context& ctx, const std::string& msg)
    {
        packet::message::Log log_pkt{};
        log_pkt.msg = msg;
        std::ignore = packet::PacketHelper::write(log_pkt, ctx.server);
    }

    Action action_;
    std::string name_;
    core::handlers::WorldManageHandler& handler_;
};
}
