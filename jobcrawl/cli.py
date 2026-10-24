"""Command line entry point: `jobcrawl <command> --profile <dir> ...`. Commands that are not written yet say so and exit 2."""
import argparse
import os
import sys

from jobcrawl.profile import ProfileError, load_profile

COMMANDS = {
    "build": "write the board files (jobs-index, description shards, jobs.json) from a catalog",
    "embed": "embed the roles into the site's vector files (needs the embed extra)",
    "publish": "build the match files (keyword index, prefs, neighbours) and config.json for the web app",
    "map": "build the atlas layout from the vectors (needs the map extra)",
}


def build_parser():
    parser = argparse.ArgumentParser(prog="jobcrawl", description="Crawl, classify and explore public job boards. Profiles define the field.")
    sub = parser.add_subparsers(dest="command", metavar="command")
    for name, text in COMMANDS.items():
        sp = sub.add_parser(name, help=text, description=text)
        sp.add_argument("--profile", metavar="DIR", required=(name == "build"), help="profile folder (profiles/schema.md)")
        if name == "build":
            sp.add_argument("--catalog", metavar="FILE", required=True, help="catalog.json written by the crawler")
            sp.add_argument("--out", metavar="DIR", required=True, help="site folder to write")
            sp.add_argument("--excerpt", type=int, metavar="N", help="cut descriptions to N characters (default: full text)")
        if name in ("embed", "publish", "map"):
            sp.add_argument("--site", metavar="DIR", help="site folder")
    return parser


def cmd_build(args):
    from jobcrawl import board
    if args.excerpt is not None and args.excerpt < 1:
        print("jobcrawl build: --excerpt needs a number of characters, 1 or more", file=sys.stderr)
        return 2
    try:
        profile = load_profile(args.profile)
    except ProfileError as e:
        print(f"jobcrawl build: {e}", file=sys.stderr)
        return 2
    except OSError as e:
        print(f"jobcrawl build: cannot read the profile: {e}", file=sys.stderr)
        return 2
    if not os.path.exists(args.catalog):
        print(f"jobcrawl build: catalog not found: {args.catalog} (run the crawler first)", file=sys.stderr)
        return 2
    try:
        counts = board.build(profile, args.catalog, args.out, args.excerpt)
    except board.BoardError as e:
        print(f"jobcrawl build: {e}", file=sys.stderr)
        return 2
    print(f"jobcrawl build: {counts['roles']} roles, {counts['shards']} description shards, feed of {counts['feed']} -> {args.out}")
    return 0


def main(argv=None):
    parser = build_parser()
    args = parser.parse_args(argv)
    if not args.command:
        parser.print_help()
        return 2
    if args.command == "build":
        return cmd_build(args)
    print(f"jobcrawl {args.command}: not implemented yet", file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main())
