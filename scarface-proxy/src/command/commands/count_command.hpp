#pragma once
#include <charconv>
#include <string>
#include <string_view>
#include <system_error>
#include <tuple>

#include <fmt/format.h>

#include "../command.hpp"
#include "../command_registry.hpp"
#include "../../core/handlers/fast_drop_handler.hpp"
#include "../../packet/packet_helper.hpp"
#include "../../packet/message/chat.hpp"

namespace command {
// "/count [amount]": sets how many items Fast Drop drops (0 = everything).
class CountCommand final : public ICommand {
public:
    explicit CountCommand(core::handlers::FastDropHandler& handler)
        : handler_{ handler }
    {

    }

    [[nodiscard]] std::string_view name() const override { return "count"; }
    [[nodiscard]] std::string description() const override { return "Set the Fast Drop amount (0 = all)"; }

    Result execute(const Context& ctx) override
    {
        if (ctx.args.empty()) {
            send_log(ctx, fmt::format("Fast drop amount: `w{}``", amount_text(handler_.get_amount())));
            return Result::Success;
        }

        const std::string& arg{ ctx.args[0] };
        int value{};
        auto [ptr, ec]{ std::from_chars(arg.data(), arg.data() + arg.size(), value) };
        if (ec != std::errc{} || ptr != arg.data() + arg.size() || value < 0) {
            send_log(ctx, fmt::format("`4Usage: ``{}count <amount>`` (0 = all)", ctx.registry.prefix()));
            return Result::InvalidArguments;
        }

        handler_.set_amount(value);
        send_log(ctx, fmt::format("Fast drop amount set to `w{}", amount_text(value)));
        return Result::Success;
    }

private:
    static std::string amount_text(const int amount)
    {
        return amount == 0 ? std::string{ "all" } : std::to_string(amount);
    }

    static void send_log(const Context& ctx, const std::string& msg)
    {
        packet::message::Log log_pkt{};
        log_pkt.msg = msg;
        std::ignore = packet::PacketHelper::write(log_pkt, ctx.server);
    }

    core::handlers::FastDropHandler& handler_;
};
}
