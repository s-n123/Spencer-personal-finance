import { describe, expect, it } from "vitest";
import { matchExactKeyword, matchKeyword, screenCrisis, screenMessage } from "./screen";

describe("matchKeyword", () => {
  it.each([
    ["STOP", "STOP"],
    ["stop", "STOP"],
    ["  Stop.  ", "STOP"],
    ["STOP!!!", "STOP"],
    ["'stop'", "STOP"],
    ["stop 🛑", "STOP"],
    ["STOPALL", "STOP"],
    ["Unsubscribe", "STOP"],
    ["cancel", "STOP"],
    ["END", "STOP"],
    ["quit", "STOP"],
    ["Revoke", "STOP"],
    ["opt out", "STOP"],
    ["Opt-Out", "STOP"],
    ["optout", "STOP"],
    ["START", "START"],
    ["unstop", "START"],
    ["help", "HELP"],
    ["Info?", "HELP"],
    ["DELETE", "DELETE"],
    ["yes delete", "YES_DELETE"],
    ["YES, DELETE", "YES_DELETE"],
    ["yes", "YES"],
    ["Y", "YES"],
    ["agree", "YES"],
    ["I agree.", "YES"],
    ["My Data", "MY_DATA"],
    ["subscribe", "SUBSCRIBE"],
    ["BILLING", "BILLING"],
  ])("%j -> %s", (text, expected) => {
    expect(matchKeyword(text)).toBe(expected);
  });

  it.each([
    "stop texting me",
    "Stop texting me!",
    "please stop texting me",
    "Please, stop messaging me.",
    "stop messaging",
    "leave me alone",
    "Leave me alone!!",
    "don't text me",
    "dont text me anymore",
    "Don’t text me again",
    "do not message me",
    "unsubscribe me",
    "unsubscribe me please",
    "stop texting me, I want to die",
  ])("plain-language opt-out %j -> STOP", (text) => {
    expect(matchKeyword(text)).toBe("STOP");
  });

  it.each([
    "stop by the store",
    "end of the day snack",
    "I'm starving, what's for dinner?",
    "my ex won't stop texting me",
    "my mom won't leave me alone about my diet",
    "stop texting me before 8",
    "stop texting me so much",
    "don't text me in the morning",
    "help me pick a dinner",
    "yes please",
    "yesterday I had pasta",
    "cancel my last meal",
    "the end",
    "info on protein",
    "delete that meal",
    "start my day with oats",
    "",
    "   ",
  ])("not a keyword: %j", (text) => {
    expect(matchKeyword(text)).toBeNull();
  });

  it("matchExactKeyword ignores opt-out phrases inside longer messages", () => {
    expect(matchExactKeyword("STOP")).toBe("STOP");
    expect(matchExactKeyword("stop texting me, I want to die")).toBeNull();
  });
});

describe("screenCrisis", () => {
  it.each([
    ["I can't breathe", "emergency"],
    ["i cant breathe and my lips are tingling", "emergency"],
    ["I cannot catch my breath", "emergency"],
    ["having trouble breathing after lunch", "emergency"],
    ["I have chest pain", "emergency"],
    ["sharp pain in my chest", "emergency"],
    ["my throat is closing", "emergency"],
    ["my throat feels like it's swelling", "emergency"],
    ["I think I overdosed", "emergency"],
    ["I've overdosed on my pills", "emergency"],
    ["took way too many pills", "emergency"],
    ["I just passed out", "emergency"],
    ["I fainted at the gym", "emergency"],
    ["I keep fainting", "emergency"],
    ["having a severe allergic reaction to shrimp", "emergency"],
    ["I'm having an allergic reaction", "emergency"],
    ["I'm going into anaphylaxis", "emergency"],
    ["I needed my epipen", "emergency"],
    ["my lips are swelling after the shrimp", "emergency"],
    ["my face is swelling up", "emergency"],
    ["I think I'm having a heart attack", "emergency"],
    ["I want to kill myself", "self_harm"],
    ["thinking about killing myself", "self_harm"],
    ["I want to die", "self_harm"],
    ["i wanna die", "self_harm"],
    ["I wish I was dead", "self_harm"],
    ["I want to end my life", "self_harm"],
    ["feeling suicidal", "self_harm"],
    ["thinking about suicide", "self_harm"],
    ["I want to hurt myself", "self_harm"],
    ["I've been cutting myself", "self_harm"],
    ["self-harm again", "self_harm"],
    ["everyone would be better off dead without me", "self_harm"],
    ["I don't want to be alive", "self_harm"],
    ["I feel like hurting myself", "self_harm"],
    ["I've been cutting myself on purpose", "self_harm"],
    ["I hurt myself on purpose", "self_harm"],
    ["I just want to end it all", "self_harm"],
    ["sometimes I want to be dead", "self_harm"],
    ["I've been starving myself", "ed"],
    ["I need to starve myself this week", "ed"],
    ["I made myself throw up", "ed"],
    ["I keep making myself vomit after dinner", "ed"],
    ["purging after every meal", "ed"],
    ["I binge and purge", "ed"],
    ["taking laxatives to lose weight", "ed"],
    ["I've been taking diet pills", "ed"],
    ["I haven't eaten in 3 days", "ed"],
    ["haven't eaten in two days", "ed"],
    ["havent eaten anything for a couple of days", "ed"],
    ["I have not eaten in days", "ed"],
    ["didn't eat for a week", "ed"],
    ["I haven’t eaten in like 4 days", "ed"],
    ["I haven't eaten in 48 hours", "ed"],
    ["havent eaten anything in 72 hrs", "ed"],
  ])("%j -> %s", (text, expected) => {
    expect(screenCrisis(text)).toBe(expected);
  });

  it.each([
    "I'm starving, what's for dinner?",
    "starving after my workout",
    "this burrito is to die for",
    "I'm dying to try that place",
    "the gym killed me today",
    "this workout is killing me",
    "stop by the store",
    "end of the day snack",
    "I don't want to die young so I'm eating better",
    "I want to diet",
    "I hurt myself at the gym",
    "I cut myself a slice of cake",
    "made myself sick eating too much candy",
    "can peanuts cause anaphylaxis?",
    "I had a mild allergic reaction to that once",
    "what's the overdose risk for vitamin D?",
    "I haven't eaten in a day",
    "haven't eaten since breakfast",
    "I haven't eaten in 1 day",
    "I haven't eaten in 5 hours",
    "haven't eaten in hours, starving",
    "I haven't eaten in 24 hours",
    "my face is swollen from crying",
    "let's end it all with dessert",
    "I don't want to be dead tired tomorrow",
    "I want to be dead asleep by 10",
    "my doctor said taking laxatives to help with constipation is fine",
    "should I purge my pantry of junk food?",
    "chest day at the gym",
    "my breath smells like garlic",
    "I passed the test",
    "suicide squeeze bunt",
  ])("no crisis: %j", (text) => {
    // "suicide squeeze" is a deliberate trade-off: the word alone is treated as a hit.
    const expected = text.startsWith("suicide") ? "self_harm" : null;
    expect(screenCrisis(text)).toBe(expected);
  });

  it("self-harm wins over emergency and ED when several match", () => {
    expect(screenCrisis("I overdosed and I want to die")).toBe("self_harm");
    expect(screenCrisis("I made myself throw up and now I have chest pain")).toBe("emergency");
  });
});

describe("screenMessage", () => {
  it("returns both tags for a message that is an opt-out and a crisis", () => {
    expect(screenMessage("stop texting me, I want to die")).toEqual({ keyword: "STOP", crisisKind: "self_harm" });
  });

  it("handles null text (photo-only messages)", () => {
    expect(screenMessage(null)).toEqual({ keyword: null, crisisKind: null });
  });
});
