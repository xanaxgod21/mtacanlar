#pragma once
#include <cstddef>
#include <cstdint>
#include <string>

#include <fmt/args.h>
#include <fmt/format.h>
#include <sol/sol.hpp>

namespace scripting::bindings {
// Converts a Lua value the same way Lua's tostring() does (honors __tostring).
[[nodiscard]] inline std::string lua_to_string(lua_State* L, const int index)
{
    std::size_t len{ 0 };
    const char* str{ luaL_tolstring(L, index, &len) };
    std::string result{ str, len };
    lua_pop(L, 1);
    return result;
}

// Formats args[first] with the remaining args using fmt syntax, e.g.
// ("Player {} at ({}, {})", name, x, y). Numbers and booleans keep their type so
// specifiers like {:.1f} work; everything else is passed through tostring().
// Returns the format string unchanged if there are no arguments or it is invalid.
[[nodiscard]] inline std::string format_lua_args(const sol::variadic_args& args, const std::size_t first = 0)
{
    if (args.size() <= first) {
        return {};
    }

    lua_State* L{ args.lua_state() };
    const int base{ args.stack_index() + static_cast<int>(first) };
    const int count{ static_cast<int>(args.size() - first) };

    std::string format_str{ lua_to_string(L, base) };
    if (count == 1) {
        return format_str;
    }

    fmt::dynamic_format_arg_store<fmt::format_context> store{};
    for (int i{ 1 }; i < count; ++i) {
        const int index{ base + i };
        switch (lua_type(L, index)) {
        case LUA_TNUMBER:
            if (lua_isinteger(L, index)) {
                store.push_back(static_cast<std::int64_t>(lua_tointeger(L, index)));
            }
            else {
                store.push_back(static_cast<double>(lua_tonumber(L, index)));
            }
            break;
        case LUA_TBOOLEAN:
            store.push_back(lua_toboolean(L, index) != 0);
            break;
        default:
            store.push_back(lua_to_string(L, index));
            break;
        }
    }

    try {
        return fmt::vformat(format_str, store);
    }
    catch (const fmt::format_error&) {
        return format_str;
    }
}
}
