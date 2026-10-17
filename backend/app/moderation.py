"""Username moderation.

Usernames are normalized (lowercased, common leetspeak undone, repeated letters
collapsed) and then checked against two lists:

- BLOCKED_ANYWHERE: terms rejected even inside a longer name ("xfuckx").
- BLOCKED_AS_WORD:  short terms that also appear inside innocent words
  (ass/classic, spic/spicy, coon/raccoon), so they're only rejected as a whole
  word, i.e. a segment between '.', '_', '-' or digits.

This is a starting point, not exhaustive; extend the lists as needed.
"""

import re

BLOCKED_ANYWHERE = {
    # Slurs
    "nigger", "nigga", "faggot", "fagot", "retard", "tranny", "kike", "chink",
    "wetback", "beaner", "raghead", "towelhead", "dyke", "shemale", "gypsy",
    # Profanity / sexual
    "fuck", "shit", "bitch", "cunt", "whore", "slut", "bastard", "asshole",
    "dildo", "pussy", "wank", "twat", "porn", "penis", "vagina", "boner",
    "blowjob", "handjob", "jizz", "cumshot", "bollock", "douche", "rapist",
    "pedo", "nazi", "hitler",
}

BLOCKED_AS_WORD = {
    "ass", "arse", "cum", "tit", "tits", "hoe", "homo", "spic", "coon", "rape",
    "crap", "dick", "cock", "anal", "jap", "gook", "wop", "fag", "damn", "hell",
    "piss", "sex", "fap", "kkk",
}

_LEET = str.maketrans({"0": "o", "1": "i", "3": "e", "4": "a", "5": "s",
                       "7": "t", "8": "b", "9": "g", "@": "a", "$": "s", "!": "i"})


def _collapse(s: str) -> str:
    """'fuuuck' -> 'fuck'. Applied to both sides so 'ass' still matches 'as'."""
    return re.sub(r"(.)\1+", r"\1", s)


_ANYWHERE = {_collapse(t) for t in BLOCKED_ANYWHERE}
_AS_WORD = BLOCKED_AS_WORD | {_collapse(t) for t in BLOCKED_AS_WORD}


def is_username_allowed(username: str) -> bool:
    lowered = username.lower()

    # Whole-name check with separators removed and leetspeak undone: "f.u.c.k", "sh1t".
    joined = re.sub(r"[._-]", "", lowered).translate(_LEET)
    for form in (joined, _collapse(joined)):
        if any(term in form for term in _ANYWHERE):
            return False

    # Word check: segments between separators/digits ("big_ass", "ass69"), plus the
    # leet-decoded segments ("a55").
    words = set(re.split(r"[._\-\d]+", lowered))
    words |= set(re.split(r"[._-]+", lowered.translate(_LEET)))
    words |= {_collapse(w) for w in words}
    return words.isdisjoint(_AS_WORD)
