"""Command line entry point: `jobcrawl <command> --profile <dir> ...`. Commands are stubs until their phase is implemented."""
import argparse
import sys

COMMANDS = {
    "build": "write the board files (jobs-index, descriptions, jobs.json) from a catalog",
    "embed": "embed the roles into the site's vector files (needs the embed extra)",
    "publish": "build the match files (keyword index, prefs, neighbours) and config.json for the web app",
    "map": "build the atlas layout from the vectors (needs the map extra)",
}


def build_parser():
    parser = argparse.ArgumentParser(prog="jobcrawl", description="Crawl, classify and explore public job boards. Profiles define the field.")
    sub = parser.add_subparsers(dest="command", metavar="command")
    for name, text in COMMANDS.items():
        sp = sub.add_parser(name, help=text, description=text)
        sp.add_argument("--profile", metavar="DIR", help="profile folder (profiles/schema.md)")
        if name == "build":
            sp.add_argument("--catalog", metavar="FILE", help="catalog.json written by the crawler")
            sp.add_argument("--out", metavar="DIR", help="site folder to write")
            sp.add_argument("--excerpt", type=int, metavar="N", help="cut descriptions to N characters (default: full text)")
        if name in ("embed", "publish", "map"):
            sp.add_argument("--site", metavar="DIR", help="site folder")
    return parser


def main(argv=None):
    parser = build_parser()
    args = parser.parse_args(argv)
    if not args.command:
        parser.print_help()
        return 2
    print(f"jobcrawl {args.command}: not implemented yet", file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main())
