// Every key a client stores the reader's data under, so web and native use
// identical names. The values are frozen: renaming one orphans everything
// already saved under the old name, with no error anywhere.
export const STORAGE_KEYS = {
	/** Saved events, as eventId strings (identity.ts). */
	starred: "eventyr:starred",
	/** Swiped-away events, as eventId strings. */
	hidden: "eventyr:hidden",
	/** The hidden events that were an explicit "not interested". */
	disliked: "eventyr:disliked",
	/** The learned taste profile (taste.ts). */
	taste: "eventyr:taste",
	/** Which share/calendar signals were already counted, by eventHash. */
	tasteNoted: "eventyr:taste-noted",
	/** Stated tag preferences (tagPrefs.ts). */
	tagPrefs: "eventyr:tag-prefs",
} as const;
