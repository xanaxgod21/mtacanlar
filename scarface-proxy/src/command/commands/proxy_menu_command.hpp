#pragma once
#include <string>
#include <string_view>

#include "../command.hpp"
#include "../../core/handlers/proxy_menu_handler.hpp"

namespace command {
// "/proxy": opens the Scarface Proxy options menu (checkbox panel).
class ProxyMenuCommand final : public ICommand {
public:
    explicit ProxyMenuCommand(core::handlers::ProxyMenuHandler& menu)
        : menu_{ menu }
    {

    }

    [[nodiscard]] std::string_view name() const override { return "proxy"; }
    [[nodiscard]] std::string description() const override { return "Open the Scarface Proxy options menu"; }

    Result execute(const Context&) override
    {
        menu_.open();
        return Result::Success;
    }

private:
    core::handlers::ProxyMenuHandler& menu_;
};
}
