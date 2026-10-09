Hi Dana,

Front Desk is ready to try! You, Marcus and Ines can see who visited. Sam, Priya, Jonas, Ruth and Kenji can see how busy the lobby is, but not who anyone is. Nobody else can get in.

## What I found in the data

- **58 visits were recorded twice** (the badge printer retries you mentioned). I count each pair once, so the real total is **1,953 visits**, not 2,011. Without that fix, every count would be about 3% too high.
- **Mon 10 to Thu 13 Aug has no records**, because the iPad was down. The app flags any period that includes those days, and leaves them out of the day-of-week averages so they don't make Mondays to Thursdays look quiet. Each weekday is only compared with the same weekday, so Fridays are measured against other Fridays.
- **About 45% of visitors never sign out**, so "busy" is based on arrivals, not how many people were inside at once. The page says this clearly. I don't show an average visit length because it wouldn't be reliable.
- **Two people on the access list would have been locked out**: Marcus's email has capital letters and Ines's has extra spaces. The app ignores both, so they can sign up normally.

## When the lobby is busy (Jul–Sep)

- **Busiest days:** Tuesday and Wednesday (about 40 visits a day), then Thursday (35), Monday (25) and Friday (18).
- **Busiest hour:** 9–10am, with nearly three times as many arrivals as any other hour. Every interview starts then.
- **Quietest times:** nobody arrives between 12 and 1pm or after 4pm.

You can filter by dates, visit type and host team. The filters are saved in the link, so you can send someone "interviews in August" and it opens already filtered.

## Access decisions

- **Someone not on the list** is told their email isn't on the Front Desk list, and asked to check the spelling or contact the Workplace team. A colleague with a typo is far more likely than a stranger, and the message shows the email as typed so the mistake is easy to spot. Wrong passwords always get one generic message.
- **Where a viewer would see a name,** they see a reference like "Visitor V000745". It identifies nobody, but they can ask you about that exact visit. Viewers also don't see host names or companies. You said naming staff is fine, but a host's name, a date and "interview" together can identify a candidate, and the host team gives the same picture of how busy the office is.
- **The rules are enforced on the server, not just hidden on screen.** Names are never sent to a viewer's browser. I signed in as a viewer, downloaded every visit the app would return, and searched it for every visitor name and email: none came back. The Users page is refused by both the page and the server.
- **Access follows your list.** Remove someone from `allowed_users.csv` and they lose access as soon as the app restarts, even if they already have an account or are signed in.

## What's fake, and what I'd change

**What's fake:** accounts live in a local file with no HTTPS, and sign-up only checks that an email is on the list, not that you own it, so anyone who knows a colleague's address could claim their account first. The visit data is also a one-off export, loaded once when the app starts, so new visits only appear after a fresh export and restart. The same goes for access: adding or removing someone means editing the list file and restarting. **With real visitors' data**, I'd have people sign in through Brightline's company login instead of passwords, run it on a proper server with HTTPS, and keep a log of which admin viewed which visitor, so legal can see who saw what. I'd also limit failed sign-in attempts, and agree how long visitor names are kept before deleting them (the counts can stay).

## What's next

1. Stop the badge printer creating duplicate records.
2. Keep a paper sign-in sheet for any future iPad outage.
3. Encourage visitors to sign out, so we can eventually show how many people are actually in the building at once.

Happy to walk you through it.

Etasha
