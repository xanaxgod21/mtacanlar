#include "logger_bindings.hpp"

namespace scripting::bindings {
void LoggerBindings::bind(sol::state& lua)
{
    auto logger_table{ lua.create_table() };

    logger_table.set_function("info", [](const sol::variadic_args& args) {
        if (args.size() == 0) {
            return;
        }

        const std::string msg{ args[0].as<std::string>() };
        spdlog::info("[Lua] {}", msg);
    });

    logger_table.set_function("warn", [](const sol::variadic_args& args) {
        if (args.size() == 0) {
            return;
        }

        const std::string msg{ args[0].as<std::string>() };
        spdlog::warn("[Lua] {}", msg);
    });

    logger_table.set_function("error", [](const sol::variadic_args& args) {
        if (args.size() == 0) {
            return;
        }

        const std::string msg{ args[0].as<std::string>() };
        spdlog::error("[Lua] {}", msg);
    });

    logger_table.set_function("debug", [](const sol::variadic_args& args) {
        if (args.size() == 0) {
            return;
        }

        const std::string msg{ args[0].as<std::string>() };
        spdlog::debug("[Lua] {}", msg);
    });

    logger_table.set_function("trace", [](const sol::variadic_args& args) {
        if (args.size() == 0) {
            return;
        }

        const std::string msg{ args[0].as<std::string>() };
        spdlog::trace("[Lua] {}", msg);
    });

    lua["logger"] = logger_table;
}
}
