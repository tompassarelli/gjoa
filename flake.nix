{
  description = "Gjoa — a Firefox fork built via nixpkgs's buildMozillaMach";

  inputs = {
    nixpkgs.url = "github:nixos/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        # NSS leapfrog overlay — auto-disabling.
        #
        # Firefox bumps its NSS floor faster than nixpkgs ships it (e.g. 151
        # needs 3.123.1 while nixpkgs may still be on 3.123.0). When nixpkgs
        # is behind, we substitute the upstream RTM tag; when it catches up,
        # the overlay short-circuits and we use nixpkgs's nss_latest
        # unchanged.
        #
        # The auto-off uses a two-pass nixpkgs evaluation:
        #   1. Import a bare nixpkgs (no overlays) → basePkgs
        #   2. Compare basePkgs.nss_latest.version against minNssVersion
        #   3. Apply the overlay only when basePkgs is strictly behind
        #
        # The separate base import avoids probing `prev.nss_latest` inside
        # the overlay fixed point.
        #
        # Src must be the nss-dev/nss GitHub tag, like nixpkgs' own nss: its
        # patches assume a root of coreconf/+lib/+cmd/, which the
        # ftp.mozilla.org release tarball nests one level deeper under nss/.
        #
        # To raise minNssVersion when Firefox needs a newer NSS than the
        # hardcoded floor:
        #   1. Bump minNssVersion to the new requirement
        #   2. Point nssRev at the matching NSS_x_y_RTM tag and compute
        #      nssHash via:
        #        nix-prefetch-url --unpack \
        #          https://github.com/nss-dev/nss/archive/<tag>.tar.gz \
        #          | xargs nix hash convert --hash-algo sha256 --to sri
        #
        minNssVersion = "3.125";
        nssRev = "NSS_3_125_RTM";
        nssHash = "sha256-pIRoFJYsQZzI+hJcNzTX+WT91tfXDygWE0RrirfyBPc=";

        basePkgs = import nixpkgs { inherit system; };
        nssOverlayNeeded =
          builtins.compareVersions basePkgs.nss_latest.version minNssVersion < 0;

        pkgs = if nssOverlayNeeded then
          import nixpkgs {
            inherit system;
            overlays = [
              (_final: prev: {
                nss_latest = prev.nss_latest.overrideAttrs (_old: {
                  version = minNssVersion;
                  src = prev.fetchFromGitHub {
                    owner = "nss-dev";
                    repo = "nss";
                    rev = nssRev;
                    hash = nssHash;
                  };
                });
              })
            ];
          }
        else basePkgs;

        # Firefox 153 requires cbindgen 0.29.4, ahead of the nixpkgs pin's
        # 0.29.2. Keep one derivation for buildMozillaMach and the Mach shell;
        # a package-set overlay would also rebuild unrelated consumers.
        cbindgen = pkgs.rust-cbindgen.overrideAttrs (finalAttrs: _old: {
          version = "0.29.4";
          src = pkgs.fetchFromGitHub {
            owner = "mozilla";
            repo = "cbindgen";
            rev = "v${finalAttrs.version}";
            hash = "sha256-leeHOwpzXuzg2cTjXehBnCsS+dvU4eIIFtWKeCee20U=";
          };
          cargoDeps = pkgs.rustPlatform.fetchCargoVendor {
            inherit (finalAttrs) src;
            hash = "sha256-f6YoDoiVoh0BVPYHFO1FsdI4OCsF+LY72QaD57StdIQ=";
          };
        });

        # Single source of truth for the Firefox pin.
        gjoaConfig = builtins.fromJSON (builtins.readFile ./gjoa.json);
        firefoxVersion = gjoaConfig.firefox.version;

        # engine/ is mutable, ignored state owned by the checkout. Direnv sets
        # this before flake evaluation; a lane may instead point it at another
        # prepared engine checkout.
        engineRoot = builtins.getEnv "GJOA_ENGINE_ROOT";
        engineSource =
          if engineRoot == "" then
            throw "GJOA_ENGINE_ROOT is unset; enter the checkout through direnv"
          else
            let enginePath = builtins.toPath engineRoot;
            in if !builtins.pathExists enginePath then
              throw "GJOA_ENGINE_ROOT does not exist: ${engineRoot}"
            else
              builtins.path {
                name = "gjoa-source";
                path = enginePath;
              };

        # Delegate the actual Firefox compile to nixpkgs's `buildMozillaMach`
        # — ~750 lines of carefully-tuned Nix that handles every toolchain
        # quirk (libclang paths, AS=clang, sccache invocation order,
        # wasm-sandbox libs, RLBox, mold linker, etc.) for upstream
        # firefox-unwrapped.
        #
        # We feed it our customized source: tools/prep/ downloads
        # mozilla-central to ./engine/ then overlays src/gjoa/, branding,
        # patches. Nix imports ./engine/ as the derivation source.
        #
        # TWO BUILD VARIANTS (both LOCAL/personal — portable builds for OTHER
        # people are the CI artifacts in .github/workflows/, NOT a nix package):
        #   gjoa-quickbuild = no PGO/LTO, portable. Fast to build — the quick
        #              local-build loop, and the portable target for
        #              `nix bundle`. `.#gjoa-quickbuild`.
        #   gjoa     = LTO + -march=native, tuned for THIS machine's CPU. The
        #              maintainer's daily driver (what the rofi/drun "gjoa" entry
        #              launches). Fastest at runtime, but NOT portable — it
        #              SIGILLs on a different CPU, so never hand it to anyone.
        #
        # buildMozillaMach has TWO arg lists:
        #   1. user args (pname, version, src, branding, ...) → passed directly
        #   2. callPackage args (pgoSupport, ltoSupport, crashreporterSupport, ...)
        #      → set as defaults inside, override via .override
        # The dance: build with user args, then .override the feature flags.
        mkGjoa = { pgoSupport, ltoSupport, crashreporterSupport, suffix ? "", perfFlags ? false }:
          ((pkgs.buildMozillaMach {
            pname = "gjoa${suffix}";
            version = firefoxVersion;
            applicationName = "Gjoa";
            binaryName = "gjoa";

            # The prepared, checkout-owned engine requires impure evaluation
            # because it is intentionally outside the tracked flake source.
            src = engineSource;

            # buildMozillaMach defaults to extracting a tarball. Our src is
            # already-extracted source, so override unpack to a copy.
            # chmod +w because Nix store paths are read-only by default and
            # mach writes into the source tree during build.
            #
            # Delete engine/mozconfig: it's generated by tools/prep for
            # dev-shell mach builds and sets `--without-wasm-sandboxed-libraries`,
            # which conflicts with buildMozillaMach's `--with-wasi-sysroot`
            # (mozilla configure rejects the combo). Removing it here lets
            # buildMozillaMach's own configure flags be the only source of
            # truth for nix builds.
            unpackPhase = ''
              runHook preUnpack
              cp -r $src source
              chmod -R u+w source
              rm -f source/mozconfig
              cd source
              runHook postUnpack
            '';

            # Branding lives at browser/branding/gjoa/ inside the source
            # (placed there by the prep tool). buildMozillaMach picks up
            # `branding` and translates to --with-branding= and friends.
            branding = "browser/branding/gjoa";

            extraConfigureFlags = [
              "--with-distribution-id=org.gjoa"
              "--with-app-name=gjoa"
              "--with-app-basename=Gjoa"
            ] ++ pkgs.lib.optionals perfFlags [
              # Headline optimization: -O3 (release default is -O2). LTO + PGO
              # ride on the .override below; debug + crashreporter are already
              # off in the release variant; debug symbols are dropped via
              # enableDebugSymbols in the override (keeps the nix wrapper's
              # strip/separateDebugInfo consistent — a bare --disable-debug-symbols
              # configure flag would not).
              #
              # We deliberately do NOT --disable-webrtc / --disable-eme: those
              # remove user-facing features (calls, DRM video) for no meaningful
              # build-size or speed win. Subsystem stripping is handled at the
              # pref level (defaults/pref/perf-prefs.js) plus the two genuinely
              # background subsystems below.
              "--enable-optimize=-O3"
              "--disable-parental-controls"
              "--disable-necko-wifi"
            ];

            # Prep tool creates engine/.git/ for change tracking. mach
            # detects .git/ → tries to invoke `git` for VCS metadata →
            # fails because buildMozillaMach's deps don't include git.
            extraNativeBuildInputs = [ pkgs.git ];

            meta = with pkgs.lib; {
              description = "Gjoa — a Firefox fork";
              homepage = "https://github.com/tompassarelli/gjoa";
              license = licenses.mpl20;
              platforms = platforms.linux;
              mainProgram = "gjoa";
            };
          }).override ({
            inherit pgoSupport ltoSupport crashreporterSupport;
            rust-cbindgen = cbindgen;
          } // pkgs.lib.optionalAttrs perfFlags {
            # Drop debug symbols the consistent way: this flips the nixpkgs
            # wrapper's strip + separateDebugInfo together, unlike a bare
            # --disable-debug-symbols configure flag which leaves them on.
            enableDebugSymbols = false;
          })).overrideAttrs (old: {
            # Keep only the version-stable Linux build-system patches. The
            # nixpkgs macOS SDK patches do not apply to Gjoa's Firefox source.
            patches = pkgs.lib.filter (p:
              let n = baseNameOf (toString p);
              in n == "136-no-buildconfig.patch"
              || n == "133-env-var-for-system-dir.patch"
            ) (old.patches or []);
          } // pkgs.lib.optionalAttrs perfFlags {
            # Architecture tuning for this machine's CPU. The -O level is set by
            # --enable-optimize=-O3 above (Mozilla's build owns the opt level and
            # would override an env -O anyway), so we only add -march/-mtune here.
            # -march=native makes the binary non-portable to other CPUs (fine for a
            # personal build; does NOT change the .drv hash). codegen-units=1 is
            # intentionally omitted — LTO already maximizes cross-unit optimization,
            # and codegen-units=1 would multiply Rust build time for no measured win.
            CFLAGS = "-march=native -mtune=native -pipe";
            CXXFLAGS = "-march=native -mtune=native -pipe";
            RUSTFLAGS = "-C target-cpu=native -C opt-level=3";

            # Without this the cc-wrapper strips the native CFLAGS above.
            # nixpkgs' stdenv/setup defaults `NIX_ENFORCE_NO_NATIVE=1`
            # (`${NIX_ENFORCE_NO_NATIVE-1}`, no colon → applies only when UNSET),
            # and the cc-wrapper strips -march=native/-mtune=native when that
            # per-target var resolves to 1 ("warning: Skipping impure flag
            # -march=native because NIX_ENFORCE_NO_NATIVE is set"). Setting it
            # `false` renders an empty-but-SET env var, so stdenv's `-1` default
            # does NOT fire, mangleVarBool ORs 0, and the native flags pass
            # through. This makes the binary CPU-specific as intended.
            NIX_ENFORCE_NO_NATIVE = false;

          });

        # Quickbuild variant — what you build day-to-day. Skips PGO+LTO.
        gjoa-quickbuild-unwrapped = mkGjoa {
          pgoSupport = false;
          ltoSupport = false;
          crashreporterSupport = false;
        };

        # Native variant — LTO + -march=native, tuned for THE BUILDING machine's
        # CPU. The maintainer's personal daily build: fastest, but NOT portable
        # (perfFlags sets -march=native, so it SIGILLs on a different CPU). Do
        # NOT distribute this — other people get the portable CI builds
        # (.github/workflows/, mach --enable-optimize, no -march=native).
        #
        # PGO stays disabled because the history SQLite connection deadlocks the
        # profile-before-change shutdown barrier during the instrumented run.
        gjoa-native-unwrapped = mkGjoa {
          pgoSupport = false;
          ltoSupport = true;
          crashreporterSupport = false;  # would need dump_syms; not yet wired
          suffix = "-native";
          perfFlags = true;
        };

        # Wrap the unwrapped derivations with `wrapFirefox` — adds the .desktop
        # file, app icon registration, manpage, dbus name, GTK paths, plugin
        # dirs, and the binary launcher script. Without this, `nix profile
        # install` / home-manager install produces a binary in the nix store
        # but no XDG integration → invisible to rofi/drun/dock/launchers.
        #
        # Mirrors nixpkgs's own pattern:
        #   firefox = wrapFirefox firefox-unwrapped { };
        # Most attrs (applicationName, binaryName, branding, mainProgram) flow
        # through from the unwrapped derivation — `wrapFirefox { }` reads them
        # from there.
        gjoa-quickbuild = pkgs.wrapFirefox gjoa-quickbuild-unwrapped { };
        gjoa-native = pkgs.wrapFirefox gjoa-native-unwrapped { };
      in
      {
        # `.gjoa` / `.default` = the NATIVE personal build — what your nixos
        # config installs (modules/gjoa → packages.<sys>.gjoa), so the rofi/drun
        # "gjoa" entry launches it. -march=native ⇒ a nixos-rebuild that touches
        # this input is a ~1.5–2h LTO compile (cache it once and you're fine).
        #
        # `.gjoa-quickbuild` = the fast, no-opt, PORTABLE variant — the quick
        # local-build loop and the target for `nix bundle .#gjoa-quickbuild`
        # (a relocatable Linux executable).
        #
        # There is intentionally NO nix "release": portable builds for other
        # people are the cross-platform CI artifacts (.github/workflows/).
        #
        # The `*-unwrapped` outputs are the raw buildMozillaMach derivations,
        # exposed for downstream consumers that want to do their own wrapping.
        packages.default = gjoa-native;
        packages.gjoa = gjoa-native;
        packages.gjoa-unwrapped = gjoa-native-unwrapped;
        packages.gjoa-native = gjoa-native;
        packages.gjoa-native-unwrapped = gjoa-native-unwrapped;
        packages.gjoa-quickbuild = gjoa-quickbuild;
        packages.gjoa-quickbuild-unwrapped = gjoa-quickbuild-unwrapped;

        # The default shell carries repository tooling; .envrc selects the
        # mach shell with the complete Firefox toolchain.
        devShells.default = pkgs.mkShell {
          packages = with pkgs; [
            # Bun is the runtime for all tools/* (TS without node).
            bun
            # mach itself wants python3, even though we drive it via fish/bun.
            python3
            python3Packages.pip
            python3Packages.virtualenv
            # tools/prep/patches.ts shells out to git for git-apply.
            git
            # SVG → PNG icon rendering (tools/icons/generate.ts).
            librsvg
          ];

          shellHook = ''
            if [[ $- == *i* ]]; then
              echo "gjoa minimal development shell"
            fi
          '';
        };

        devShells.mach = pkgs.mkShell {
          packages = with pkgs; [
            # Same as default + the Firefox build toolchain.
            bun
            python3
            python3Packages.pip
            python3Packages.virtualenv
            git
            mercurial
            gnumake
            librsvg

            # Toolchain — match what buildMozillaMach uses (llvm 19+).
            llvmPackages_19.clang
            llvmPackages_19.bintools
            llvmPackages_19.libclang
            llvmPackages_19.lld
            rustc
            cargo
            cbindgen
            nasm
            yasm
            autoconf
            m4
            pkg-config
            unzip
            zip
            perl
            which

            # Build acceleration.
            sccache
            ccache
            mold

            # Native deps Firefox links against at compile/link time.
            gtk3
            glib
            dbus
            libGL
            libdrm
            mesa
            libxkbcommon
            wayland
            libx11
            libxcomposite
            libxdamage
            libxext
            libxfixes
            libxrandr
            libxtst
            libxcb
            libxi
            libxrender
            libxscrnsaver
            alsa-lib
            libpulseaudio
            cups
            nss
            nspr
            libffi
            zlib
            bzip2
            libjpeg
            libpng
            libvpx
            libwebp
            libevent
            fontconfig
            freetype
            pango
          ];

          shellHook = ''
            # ---- Toolchain env (mirrors what buildMozillaMach sets up) ----
            # bindgen needs libclang for Rust ↔ C bridge generation.
            export LIBCLANG_PATH="${pkgs.llvmPackages_19.libclang.lib}/lib"

            # AS=as in env causes mach failure (see mozilla bug 1497286).
            # mach picks the right assembler from clang automatically.
            unset AS

            # Don't try to send libnotify desktop notifications during build.
            export MOZ_NOSPAM=1

            # mach build state cache; in-tree so it ties to this checkout.
            export MOZBUILD_STATE_PATH="$PWD/engine/.mozbuild"
            export MOZ_OBJDIR="$PWD/engine/obj-x86_64-pc-linux-gnu"

            if [[ $- == *i* ]]; then
              cat <<'EOF'

gjoa mach shell — full Firefox build toolchain wired in.

  DAILY DEV LOOP (sub-30-sec for JS/CSS, few min for C++):
    bun run import               # re-apply overlays
    cd engine && ./mach build faster

  TROUBLESHOOTING:
    cd engine && ./mach clobber  # wipe obj-* if state gets confused

  NIX BUILD WHEN:
    - First time on this machine (or after `git clean`)
    - Bumping Firefox version
    - Toolchain change in flake.nix
EOF
            fi
          '';
        };
      });
}
