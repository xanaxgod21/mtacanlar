#include "logger_bindings.hpp"
#include "lua_format.hpp"

namespace scripting::bindings {
void LoggerBindings::bind(sol::state& lua)
{
    auto logger_table{ lua.create_table() };

    logger_table.set_function("info", [](const sol::variadic_args& args) {
        if (args.size() == 0) {
            return;
        }

        spdlog::info("[Lua] {}", format_lua_args(args));
    });

    logger_table.set_function("warn", [](const sol::variadic_args& args) {
        if (args.size() == 0) {
            return;
        }

        spdlog::warn("[Lua] {}", format_lua_args(args));
    });

    logger_table.set_function("error", [](const sol::variadic_args& args) {
        if (args.size() == 0) {
            return;
        }

        spdlog::error("[Lua] {}", format_lua_args(args));
    });

    logger_table.set_function("debug", [](const sol::variadic_args& args) {
        if (args.size() == 0) {
            return;
        }

        spdlog::debug("[Lua] {}", format_lua_args(args));
    });

    logger_table.set_function("trace", [](const sol::variadic_args& args) {
        if (args.size() == 0) {
            return;
        }

        spdlog::trace("[Lua] {}", format_lua_args(args));
    });

    lua["logger"] = logger_table;
}
}
