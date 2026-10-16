#pragma once
#include <filesystem>
#include <fstream>
#include <ios>
#include <string_view>

#include <spdlog/spdlog.h>

// The built-in HTTPS web server (src/core/web_server.cpp) loads
// resources/cert.pem and resources/key.pem at startup and cannot bind port 443
// without them. They are embedded here and (re)written on every run, so the
// proxy ships as a single self-contained exe and a stale/expired cert left in
// resources/ is always replaced (items.dat is fetched from the game server at
// login, scripts/ and config.json are created on demand).
//
// This is a self-signed certificate valid for the Growtopia hostnames
// (growtopia1.com / growtopia2.com and their subdomains), good until 2036.
// Growtopia connects to the proxy over HTTPS for server_data.php, so the cert
// must be unexpired and carry those names or the client drops the connection.
namespace core {
inline constexpr std::string_view EMBEDDED_CERT_PEM{ R"PEM(-----BEGIN CERTIFICATE-----
MIIDsTCCApmgAwIBAgIUOoUh5rbR8MBD/l9+YA62GjgKKqAwDQYJKoZIhvcNAQEL
BQAwGTEXMBUGA1UEAwwOU2NhcmZhY2UgUHJveHkwHhcNMjYxMDE2MTAxMjMzWhcN
MzYxMDEzMTAxMjMzWjAZMRcwFQYDVQQDDA5TY2FyZmFjZSBQcm94eTCCASIwDQYJ
KoZIhvcNAQEBBQADggEPADCCAQoCggEBALajK3gWLh2wDGX8T5iN7nCAbb35atlF
HIA2C9tp50vWCWtylZX/d81wZ9zYWoGhGInjS9saAyRJ7UZt36VlLqaeu1Jvj2MQ
0EWhq6VOHEcYnF2/cmtyZ3Mmcsue636kX9ejeG4Ek4K1Njh7yhwAjmaAVknQVXNE
Y/JkhwoZ4EQIKlOAVAesxNQm/ER2G4MNCVTL0oH0hJdKC5NLIxusxO/Iwx2JTtif
GMhPbIzsLdNSns7kWTRNp1mDwo47WLQCJ4CsfRyRpzCWmCGUBJjARi6wLDRT+zKE
TLBiWPN7z8HDYXxkCJOOPpTYLls239A4KPpJWjPPCYsI+Vx1ZDdwH1kCAwEAAaOB
8DCB7TAdBgNVHQ4EFgQUwzmdncToPQT9xswTdJJiI8nHWrswHwYDVR0jBBgwFoAU
wzmdncToPQT9xswTdJJiI8nHWrswDwYDVR0TAQH/BAUwAwEB/zB1BgNVHREEbjBs
gg5ncm93dG9waWExLmNvbYIOZ3Jvd3RvcGlhMi5jb22CECouZ3Jvd3RvcGlhMS5j
b22CECouZ3Jvd3RvcGlhMi5jb22CEnd3dy5ncm93dG9waWExLmNvbYISd3d3Lmdy
b3d0b3BpYTIuY29tMA4GA1UdDwEB/wQEAwICpDATBgNVHSUEDDAKBggrBgEFBQcD
ATANBgkqhkiG9w0BAQsFAAOCAQEAk2Gwkq8MC2hFEKH7m0fZ95JL4SBJppNgwfqs
0dBvfkNlujnLx7MFk52fmF++IwMTVmgIDUcukby7CDRPMFv//zV4U+PAlKcXFaIx
M31Nd4lxym59In60HOlhf8H1mRIa2mzucKGm4oXlbJRGAem6Bp0vr6+WsBdSJlMm
aZzpj0rhU6YmHVRSregn2pzr5cO17TIwGeybkVulqShGU68/IK1FolVKWCNhzVl6
HsZqvxY5bWF8stNTWiztN45+7HsYKUWnGwZaI9DIVq1/IQ5yZutASUvdYAWLEfNt
XtIgixznjSWZuVLQmYj3cZXQNUimWl/Ioqjojp7DeyPdrz6pEQ==
-----END CERTIFICATE-----
)PEM" };
inline constexpr std::string_view EMBEDDED_KEY_PEM{ R"PEM(-----BEGIN PRIVATE KEY-----
MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC2oyt4Fi4dsAxl
/E+Yje5wgG29+WrZRRyANgvbaedL1glrcpWV/3fNcGfc2FqBoRiJ40vbGgMkSe1G
bd+lZS6mnrtSb49jENBFoaulThxHGJxdv3JrcmdzJnLLnut+pF/Xo3huBJOCtTY4
e8ocAI5mgFZJ0FVzRGPyZIcKGeBECCpTgFQHrMTUJvxEdhuDDQlUy9KB9ISXSguT
SyMbrMTvyMMdiU7YnxjIT2yM7C3TUp7O5Fk0TadZg8KOO1i0AieArH0ckacwlpgh
lASYwEYusCw0U/syhEywYljze8/Bw2F8ZAiTjj6U2C5bNt/QOCj6SVozzwmLCPlc
dWQ3cB9ZAgMBAAECggEAA1HbdisXCwCadRcdPkVkLmTTOdcJB2p/bmAtHn+iDemV
0b9rMycJ3zDaHnRLTtxmBQmd5R1nrbbvSm6wWEIK00oC1yiCd3dEheN+qnpNPsiW
fQjAFG5nrXrnLsbUeoCT4mhNBdjs8n0HP4cWgSRMclYGW4CfMQFu/KaxorAeOLZS
Xcjbgoc0UC+yA3YPkN4UsVS9eJsilg6nK6lI45CpZi2pNrPYPcMEHyhBhK47zkGQ
rKn1PNbDFQxzBs8uOdf8ui6uhCEa7L/wtaLCCP+3iKWAfNU784zWaiAYTm2aERKa
37u7bn+ATO3k2VB3WvLB7hanzrsBzLnbs+p9dS9ydQKBgQDzxcmk3TAP1xZRO6JN
+tCAcBJ9CVxLHY+hodalNgN/hMlvQhNDxm9cGiBO173hvSw9YKE70gXqKv5ijchi
XgkL6yVIhy+kjFFUUowVAa84p7Nw+UND5xHiD2cTbB533Iw/R/5frZP2NwIDTszC
BitxgxzIigW81ZbP61tCA0FXtQKBgQC/zFzYqpNOPGe2qMA9ub1NAkmFUchEZOKa
33d9VqJZK1+7yniwF3Mv4imZLn3d88srmknMP7wtnYKeba5tp22fSBN+HrtX7z78
4BGfl4y4kEYlDQdqB9o4kKWmA5jDryGML259K56rxdw7qJROzg4IP1XaKbEd6vnV
P9k1Bg2nlQKBgHAd4dYfnQFMDYmjAc0XtFm+MeKsMXSizfKq+ovVwdoeen7fRvj/
BSy5H27jrwNp/DTmgoF+4RWIXKN7TlRfp42Bww4Ojw0BNE6yAJeQxMQr7U3idtt+
JS1xpBi8u26pUx+vvwDGVq0BM73NukLqj4SPpuddA7KMEebi+n/r+1uZAoGANc1N
/jlbOQcY0NRlmOsRfxi1JwDZ/NWP+4HUMwSqZfkU0cjqMftiBHyczquMA0bwJzsQ
mIsIboNQsMBzva7JwXSmgyp7wx8JvEXeq7YHc36FLr+I5OVvAY8R6I/5umrWLkzf
4Zzq1aSbMuEHOVPz+7xIiPpJBOt1SayvcYBRNEECgYEAxLfXAYy4fWDxTbQa3qz+
+F6LJ0wKUgwH0HuA2VognSKbyW427ymGJF0v1nHvmd94TFkofMMwjlUkrNw44x+N
wqTMIodWfqmyO+pIlJNAuy/FZXCnPy0L/jA4dgTZWNPmI4J+uqY8CEMx2oXjvMf/
v8I0UCvomiskQfzO7fFdM4I=
-----END PRIVATE KEY-----
)PEM" };

inline void ensure_embedded_resources()
{
    namespace fs = std::filesystem;
    std::error_code ec;
    fs::create_directories("resources", ec);

    struct Resource {
        const char* path;
        std::string_view content;
    };

    for (const Resource res : {
        Resource{ "resources/cert.pem", EMBEDDED_CERT_PEM },
        Resource{ "resources/key.pem", EMBEDDED_KEY_PEM },
    }) {
        // Always overwrite: the cert/key are the proxy's own, not user data, and
        // rewriting them replaces any stale or expired copy from an older build.
        std::ofstream out{ res.path, std::ios::binary | std::ios::trunc };
        if (!out) {
            spdlog::warn("Could not write {}", res.path);
            continue;
        }

        out.write(res.content.data(), static_cast<std::streamsize>(res.content.size()));
        spdlog::info("Wrote embedded {}", res.path);
    }
}
}
