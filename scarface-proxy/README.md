# Scarface Proxy

Scarface Proxy is a proxy for [Growtopia](https://growtopiagame.com/) that sits between the game and its servers. It lets you debug and modify packets, and adds in-game commands for common chores (fast lock drops, auto collect, early roulette results, quick pull/kick/ban and more).

It is based on [GTProxy](https://github.com/ZTzTopia/GTProxy) by ZTzTopia (MIT license, see [LICENSE](LICENSE)).

## Supported Platforms

- Windows. Tested with Windows 7, 8, 10 and 11.
- GNU/Linux. Tested with Ubuntu and Arch Linux. (but who use GNU/Linux to play growtopia?)
- macOS. Tested with macOS 26 Tahoe.

## Features

- Open source and free to use.
- Support for Growtopia 3.92 and newer versions.
- Includes a built-in http server with metadata from the Growtopia client.
- Works well with sub-server redirection.
- Supports packet debugging and modification.
- Proxy commands for common chores (see below). Their on/off settings are saved in `config.json`.

## Commands

| Command | What it does |
|---|---|
| `/wd <n>`, `/dd <n>`, `/bd <n>` | Drop World / Diamond / Blue Gem Locks without the amount dialog. If you are short, a bigger lock is broken first (e.g. a Diamond Lock into 100 World Locks). |
| `/balance` | Show how many locks you have and their total value in World Locks. |
| `/autocollect [on\|off\|status\|range <1-5>]` | Pick up dropped items near you. Locks you just dropped are left alone. |
| `/roulette [on\|off\|status]` | Show roulette results (and reme) the moment the wheel is punched, before it stops. |
| `/spins [n]` | The last roulette spins in this world. |
| `/modalert [on\|off\|status]` | Warn (message, overlay and sound) when a moderator or invisible player is in the world. |
| `/pull <name>`, `/kick <name>`, `/ban <name>` | Pull, kick or world-ban a player in your world without opening the wrench menu. Names can be shortened. |
| `/wrench [on\|off\|status\|pull\|kick\|ban]` | When on, wrenching a player in your world instantly pulls, kicks or world-bans them with no menu. Pick the action with `pull` (alias `cek`), `kick` or `ban`. Saved in `config.json`. |
| `/proxy` | Open the options menu: a checkbox panel to toggle Wrench Pull, Show Real/Fake Spin, Auto Mod Detect, Show Fun Facts and Fast Drop. Choices are saved in `config.json`. |
| `/count [amount]` | Set the Fast Drop amount (`0` = drop everything). |
| `/collectkey [key]` | Show or set the key that toggles Auto Collect (e.g. `F6`, `C`). Windows only; fires only while the Growtopia window is focused. |
| `/pathfind [on\|off\|status]` | When on, clicking a tile teleports you there instead of punching/placing. Experimental: the server's anti-cheat may reject long jumps. |
| `/rmode [real\|reme\|qq]` | Roulette annotation shown next to every spin: `real` the number, `reme` its digit sum (32->5), `qq` its last digit (27->7). |
| `/warp <world>`, `/nick`, `/skin`, `/debug`, `/proxyhelp` | Built-in utilities. |

## Download

Builds are made by the `Scarface Proxy Windows build` GitHub Actions workflow; see [KURULUM.md](KURULUM.md) (Turkish) for setup.

## Build

The following dependencies are required to build from source:

- [CMake](https://cmake.org/).
- [Conan, the C/C++ Package Manager](https://conan.io) (2.0+).

To build from source:

1. Clone the source code with its submodules (`git clone --recurse-submodules ...`, or `git submodule update --init --recursive` in an existing clone)
2. Install Python 3.5+ (Windows only: select 'Add Python to PATH' in installer)
3. CMake will install needed package with Conan. `pip install "conan>2.0"`
    ```shell
    $ mkdir build
    $ cd build
    $ cmake .. -DCMAKE_BUILD_TYPE=Debug
    $ cmake --build .
    ```

## License

This project is licensed under the MIT License, see the [LICENSE](LICENSE) file. The original copyright notice must be kept.
