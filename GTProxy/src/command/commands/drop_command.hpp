#pragma once
#include <charconv>
#include <cstdint>
#include <string>
#include <fmt/format.h>

#include "../command.hpp"
#include "../command_registry.hpp"
#include "../../core/handlers/drop_handler.hpp"
#include "../../packet/packet_helper.hpp"
#include "../../packet/message/chat.hpp"

namespace command {
// Fast drop for a fixed item, e.g. "/wd 10" drops 10 World Locks.
class DropCommand final : public ICommand {
public:
    DropCommand(
        std::string name,
        const std::uint16_t item_id,
        std::string item_name,
        core::handlers::DropHandler& handler
    )
        : name_{ std::move(name) }
        , item_id_{ item_id }
        , item_name_{ std::move(item_name) }
        , handler_{ handler }
    {

    }

    [[nodiscard]] std::string_view name() const override { return name_; }
    [[nodiscard]] std::string description() const override { return fmt::format("Drop {}s quickly", item_name_); }

    Result execute(const Context& ctx) override
    {
        constexpr auto max_amount{ core::handlers::DropHandler::MAX_AMOUNT };

        int amount{ 0 };
        const std::string arg{ ctx.args.empty() ? "" : ctx.args[0] };
        if (
            auto [ptr, ec]{ std::from_chars(arg.data(), arg.data() + arg.size(), amount) };
            arg.empty() || ec != std::errc{} || ptr != arg.data() + arg.size() || amount < 1 || amount > max_amount
        ) {
            send_log(ctx, fmt::format("`4Usage: ``{}{} <1-{}>", ctx.registry.prefix(), name_, max_amount));
            return Result::InvalidArguments;
        }

        switch (handler_.request_drop(item_id_, amount, item_name_)) {
        case core::handlers::DropHandler::Result::Sent:
            send_log(ctx, fmt::format("Dropping `2{}`` {}", amount, item_name_));
            return Result::Success;
        case core::handlers::DropHandler::Result::NotInWorld:
            send_log(ctx, "`4Error: ``You are not in a world");
            return Result::Failed;
        case core::handlers::DropHandler::Result::NotConnected:
            send_log(ctx, "`4Error: ``Not connected to the server");
            return Result::Failed;
        case core::handlers::DropHandler::Result::InvalidAmount:
            break;
        }

        send_log(ctx, fmt::format("`4Usage: ``{}{} <1-{}>", ctx.registry.prefix(), name_, max_amount));
        return Result::InvalidArguments;
    }

private:
    static void send_log(const Context& ctx, const std::string& msg)
    {
        packet::message::Log log_pkt{};
        log_pkt.msg = msg;
        std::ignore = packet::PacketHelper::write(log_pkt, ctx.server);
    }

    std::string name_;
    std::uint16_t item_id_;
    std::string item_name_;
    core::handlers::DropHandler& handler_;
};
}
