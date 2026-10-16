import { useEffect, useState } from "react";

/**
 * Subscribe to a matchMedia query (used for the <768px mobile breakpoint).
 * Returns false during SSR / before mount, then syncs to the real media state.
 */
export function useMediaQuery(query: string): boolean {
	const [matches, setMatches] = useState(false);

	useEffect(() => {
		if (typeof window.matchMedia !== "function") return;
		const mql = window.matchMedia(query);
		// setState inside the media-change callback (event handler, not effect body)
		const onChange = () => setMatches(mql.matches);
		onChange();
		mql.addEventListener("change", onChange);
		return () => mql.removeEventListener("change", onChange);
	}, [query]);

	return matches;
}
