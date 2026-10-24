"""Command line entry point: `jobcrawl <command> --profile <dir> ...`. Every command prints what it wrote and exits 2 on a usage or profile error."""
import argparse
import os
import sys

from jobcrawl.profile import ProfileError, load_profile

COMMANDS = {
    "build": "write the board files (jobs-index, description shards, jobs.json) from a catalog",
    "embed": "embed the roles (and the companies, when the profile names a catalogue) into the vectors folder (needs the embed extra)",
    "publish": "build the match files (keyword index, prefs, neighbours) and config.json for the web app",
    "map": "build the atlas layout from the vectors (needs the map extra)",
}


def default_vectors(site):
    """The vectors folder next to the site folder: SITE/../vectors (kept out of the published folder)."""
    return os.path.join(os.path.dirname(os.path.abspath(site.rstrip(os.sep))), "vectors")


def build_parser():
    parser = argparse.ArgumentParser(prog="jobcrawl", description="Crawl, classify and explore public job boards. Profiles define the field.")
    sub = parser.add_subparsers(dest="command", metavar="command")
    for name, text in COMMANDS.items():
        sp = sub.add_parser(name, help=text, description=text)
        if name == "build":
            sp.add_argument("--profile", metavar="DIR", required=True, help="profile folder (profiles/schema.md)")
            sp.add_argument("--catalog", metavar="FILE", required=True, help="catalog.json written by the crawler")
            sp.add_argument("--out", metavar="DIR", required=True, help="site folder to write")
            sp.add_argument("--excerpt", type=int, metavar="N", help="cut descriptions to N characters (default: full text)")
        if name == "embed":
            sp.add_argument("--site", metavar="DIR", required=True, help="site folder (jobs-index.json, jobs-desc-XX.json)")
            sp.add_argument("--model-dir", metavar="DIR", required=True, help="model folder from scripts/fetch_model.py (default layout: models/eg2)")
            sp.add_argument("--profile", metavar="DIR", help="profile folder: embed.* and companies_catalogue (schema defaults without it)")
            sp.add_argument("--vectors", metavar="DIR", help="vectors folder (default: SITE/../vectors)")
            sp.add_argument("--only-missing", action="store_true", help="embed only the roles that have no vector yet")
            sp.add_argument("--threads", type=int, default=4, metavar="N", help="onnxruntime threads (default 4)")
            sp.add_argument("--sample", type=int, metavar="N", help="print N roles with their work text and stop (no model needed)")
        if name == "publish":
            sp.add_argument("--site", metavar="DIR", required=True, help="site folder (from jobcrawl build)")
            sp.add_argument("--profile", metavar="DIR", required=True, help="profile folder")
            sp.add_argument("--vectors", metavar="DIR", help="vectors folder (default: SITE/../vectors)")
        if name == "map":
            sp.add_argument("--site", metavar="DIR", required=True, help="site folder (from jobcrawl build)")
            sp.add_argument("--profile", metavar="DIR", required=True, help="profile folder (map.*, scopes, labels_file)")
            sp.add_argument("--vectors", metavar="DIR", help="vectors folder (default: SITE/../vectors)")
            sp.add_argument("--labels-only", action="store_true", help="apply the profile's group names to the layout already built")
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


def _usage_error(command, e):
    print(f"jobcrawl {command}: {e}", file=sys.stderr)
    return 2


def _check_site(command, site):
    if not os.path.exists(os.path.join(site, "jobs-index.json")):
        return _usage_error(command, f"no jobs-index.json in {site} (run jobcrawl build first)")
    return None


def cmd_embed(args):
    from jobcrawl.embed import roles
    if err := _check_site("embed", args.site):
        return err
    if args.sample:
        roles.sample(args.site, args.sample)
        return 0
    try:
        profile = load_profile(args.profile) if args.profile else None
    except (ProfileError, OSError) as e:
        return _usage_error("embed", e)
    vectors = args.vectors or default_vectors(args.site)
    if not os.path.isdir(args.model_dir):
        return _usage_error("embed", f"model folder not found: {args.model_dir} (run scripts/fetch_model.py)")
    try:
        n = roles.embed_roles(args.site, profile, args.model_dir, vectors, only_missing=args.only_missing, threads=args.threads)
        print(f"jobcrawl embed: {n} role vectors -> {vectors}")
        if profile is not None and profile.get("companies_catalogue"):
            from jobcrawl.embed import companies
            m = companies.embed_companies(profile, args.model_dir, vectors, threads=args.threads)
            print(f"jobcrawl embed: {m} company vectors -> {vectors}")
    except ImportError as e:
        return _usage_error("embed", f"{e}. The embed step needs the embed extra: pip install -r requirements-embed.txt")
    except (roles.RoleVectorError, ValueError) as e:
        return _usage_error("embed", e)
    return 0


def cmd_publish(args):
    from jobcrawl.index import publish
    if err := _check_site("publish", args.site):
        return err
    try:
        profile = load_profile(args.profile)
    except (ProfileError, OSError) as e:
        return _usage_error("publish", e)
    vectors = args.vectors or default_vectors(args.site)
    try:
        files = publish.publish(args.site, profile, vectors)
    except ImportError as e:
        return _usage_error("publish", f"{e}. Publishing with vectors needs numpy: pip install -r requirements-embed.txt")
    except (publish.PublishError, ValueError, OSError) as e:
        return _usage_error("publish", e)
    print(f"jobcrawl publish: {len(files)} files in {args.site}:")
    for f in files:
        print(f"  {f:<28} {os.path.getsize(os.path.join(args.site, f)) / 1e6:8.3f} MB")
    return 0


def cmd_map(args):
    from jobcrawl.map import atlas
    if err := _check_site("map", args.site):
        return err
    try:
        profile = load_profile(args.profile)
    except (ProfileError, OSError) as e:
        return _usage_error("map", e)
    vectors = args.vectors or default_vectors(args.site)
    try:
        if args.labels_only:
            atlas.labels_only(vectors, profile)
        else:
            atlas.build(args.site, vectors, profile)
    except ImportError as e:
        return _usage_error("map", f"{e}. The map needs the map extra: pip install -r requirements-map.txt")
    except (atlas.MapError, OSError, ValueError) as e:
        return _usage_error("map", e)
    return 0


def main(argv=None):
    parser = build_parser()
    args = parser.parse_args(argv)
    if not args.command:
        parser.print_help()
        return 2
    handlers = {"build": cmd_build, "embed": cmd_embed, "publish": cmd_publish, "map": cmd_map}
    return handlers[args.command](args)


if __name__ == "__main__":
    sys.exit(main())
