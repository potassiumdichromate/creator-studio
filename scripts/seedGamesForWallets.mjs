import "dotenv/config";
import { signToken } from "../src/services/authService.js";

// ---------------------------------------------------------------------------
// 29 { wallet, prompt } pairs. One game is generated per entry, in order.
// ---------------------------------------------------------------------------
const ENTRIES = [
  {
    wallet: "0x3905f703Ce0bE1cEc85B9e1E51D5f6dF050A6a8A",
    prompt: "Meteor Dodge\n\nCreate a 2D endless game where the player controls a tiny spaceship moving left and right at the bottom of the screen. Meteors fall from the top at increasing speeds. Survive as long as possible, collect stars for bonus points, and use occasional shields to survive one collision."
  },
  {
    wallet: "0xC4EFFeE06920842A28f63bdcE7af79b8cfBf4175",
    prompt: "One-Tap Ninja\n\nCreate a minimalist 2D game where a ninja automatically runs forward. The player taps to jump between rooftops and avoid gaps, spikes, and enemies. Add progressively faster movement and a score based on distance traveled."
  },
  {
    wallet: "0x392F6690354e2731a5F31ABccEf048020c4A9833",
    prompt: "Pizza Delivery Rush\n\nCreate a top-down hyper-casual game where the player rides a scooter through a small city delivering pizzas. Navigate around cars and pedestrians, reach customers before the timer expires, and earn coins for fast deliveries."
  },
  {
    wallet: "0x7Cd7680e862b628296ccF995a9870066A26D6FD3",
    prompt: "Magnet Collector\n\nCreate a 3D game where the player controls a magnetic ball rolling through an arena. Attract small metal objects while avoiding explosive objects. The magnet becomes stronger as more objects are collected."
  },
  {
    wallet: "0xB646C2584609EdAc8ad4D4a804BB3233022116fb",
    prompt: "Bridge Builder\n\nCreate a hyper-casual game where the player automatically moves toward gaps between islands. The player holds the screen to grow a wooden bridge and releases to stop it. The bridge must be the correct length to reach the next island. Too short or too long causes the player to fall."
  },
  {
    wallet: "0x28538922560fDF9C6B650B2e5a3D515Ca86e8593",
    prompt: "Color Switch Factory\n\nCreate a fast-paced game where colored balls move through a factory filled with rotating gates. The player taps to change the ball's color. The ball can only pass through gates matching its color. Increase speed every 10 successful gates."
  },
  {
    wallet: "0x2D6e8b1b01e291374eD33c596769cAC120dafe22",
    prompt: "Tiny Restaurant\n\nCreate a top-down restaurant management game. Customers enter, display food orders above their heads, and sit at tables. The player taps ingredients and cooking stations in the correct sequence to prepare and serve meals before customers become impatient."
  },
  {
    wallet: "0xe6da08595EC01ae867d3bbc6fdA0e6fb2401cB75",
    prompt: "Treasure Diver\n\nCreate a vertical underwater game where the player controls a diver descending into the ocean. Collect treasure while managing limited oxygen. Avoid sharks, mines, and jellyfish. The player must return to the surface before oxygen reaches zero."
  },
  {
    wallet: "0xc68a413928aAac77DebaD5722bE78Ff32DB14409",
    prompt: "Stack the Skyscraper\n\nCreate a one-button stacking game where moving building floors slide horizontally across the screen. The player taps to drop each floor onto the previous one. Misaligned sections fall away, making the tower narrower. The goal is to build the tallest skyscraper possible."
  },
  {
    wallet: "0xcd1893426c89D59A49eF377F37F1bDF8e60C9eA3",
    prompt: "Zombie Lawn Mower\n\nCreate a top-down arena game where the player drives a lawn mower through a small field filled with zombies. Automatically move forward and steer around the arena while mowing zombies. Add increasingly large zombie waves and temporary speed boosts."
  },
  {
    wallet: "0x154CCeD55Ef90A711f08839367eb7a6C6d214680",
    prompt: "Gravity Flip\n\nCreate a 2D endless runner where the character automatically runs forward. Tapping flips gravity between the floor and ceiling. Avoid spikes and obstacles on both surfaces while collecting coins. The game should progressively accelerate."
  },
  {
    wallet: "0xbf3394d8580203b2C3E597f6DbB7dF6A4549613B",
    prompt: "Rocket Landing\n\nCreate a physics-based hyper-casual game where the player controls a small rocket attempting to land on moving platforms. Use left and right thrusters to control rotation and horizontal movement. Fuel is limited, so land efficiently without crashing."
  },
  {
    wallet: "0xf40258aBF648B50BEd76E5c08DFEc5cF8735ef9d",
    prompt: "Ice Cube Rescue\n\nCreate a puzzle-action game where the player controls a small character pushing ice blocks across a frozen lake. The objective is to rescue trapped penguins by reaching them without falling through thin ice. Add simple grid-based movement and increasingly difficult levels."
  },
  {
    wallet: "0xc3446155ccC5e68Af8158C97eA06e29fc2AEf97f",
    prompt: "Traffic Controller\n\nCreate a top-down intersection simulation game. Cars continuously approach from four directions. The player taps traffic lights to change which direction has priority. Prevent crashes while allowing as many cars as possible to pass. Increase traffic density over time."
  },
  {
    wallet: "0xf4dFbC2fC23B9587aeC950E523c1756ECF08e8B8",
    prompt: "Alien Egg Collector\n\nCreate a 2D platform game where the player explores a tiny alien planet collecting glowing eggs. The character automatically jumps, and the player controls horizontal movement. Avoid alien creatures and environmental hazards while collecting every egg in each level."
  },
  {
    wallet: "0x736ce0360b7cC0C6f893eBd7CA8a0A3732A52244",
    prompt: "Sand Dig\n\nCreate a physics-based mobile game where the player swipes through sand to create a tunnel. A colored ball falls from the top and must reach a treasure chest at the bottom. Avoid rocks, lava, and traps while manipulating the sand path."
  },
  {
    wallet: "0x8B9E2F82B578E5136728d2Ac9d962e4FddA1C587",
    prompt: "Shadow Sneak\n\nCreate a stealth hyper-casual game viewed from above. The player controls a character moving between safe shadows while guards patrol predictable paths. The player must reach the exit without entering a guard's vision cone. Make each level short and progressively harder."
  },
  {
    wallet: "0x1F5F2802e5e888aCf6527CCE7E9d20C3a9952A5B",
    prompt: "Fishing Frenzy\n\nCreate a vertical fishing game. The player controls a fishing hook moving horizontally while it descends. Collect valuable fish and treasure while avoiding dangerous sea creatures. The player has limited time before the hook automatically returns to the surface."
  },
  {
    wallet: "0x730078aE732a48E1be1eE0Ee8b4255Bbec534513",
    prompt: "Robot Factory Escape\n\nCreate a side-scrolling game where a tiny robot escapes from a malfunctioning factory. The robot automatically runs while the player controls jumping and sliding. Add conveyor belts, laser barriers, crushing machines, moving platforms, and collectible batteries."
  },
  {
    wallet: "0xE9BF4C67A566f54a43cCB9f642C963dDef27c6a6",
    prompt: "Bubble Cannon\n\nCreate a physics-based game where the player controls a cannon at the bottom of the screen. Shoot colored bubbles upward. Matching three or more bubbles causes them to disappear. Add bouncing walls and limited shots per level."
  },
  {
    wallet: "0x4256b029B83BD7d3581ceCbfEE12Fea0485F7F52",
    prompt: "Volcano Climber\n\nCreate a vertical climbing game where the player jumps between platforms while a lava wave rises from below. Platforms move, disappear, and rotate. The objective is to climb as high as possible without being caught by lava."
  },
  {
    wallet: "0x74D21B45469e661969C39f856e76772c13d56F2a",
    prompt: "Sheep Herd\n\nCreate a top-down game where the player controls a shepherd trying to guide scattered sheep into a fenced area. Sheep move unpredictably and avoid the player. Use simple movement and positioning mechanics to herd all sheep before time runs out."
  },
  {
    wallet: "0xC5743ff9ac2C8543B288B19AdcDe7C4021C307f3",
    prompt: "Laser Mirror\n\nCreate a grid-based puzzle game where a laser starts from one side of the screen and must reach a target crystal. The player rotates mirrors by tapping them to redirect the laser. Add increasingly complex layouts with multiple mirrors and obstacles."
  },
  {
    wallet: "0x1d629FDce27a5C8714cf758Aa8622369220400C2",
    prompt: "Pirate Cannon\n\nCreate a physics-based island destruction game. The player controls a pirate cannon and launches cannonballs at enemy structures. Destroy all enemy targets using the fewest shots possible. Add destructible wooden structures and explosive barrels."
  },
  {
    wallet: "0xEde8e8fb6Dae1C3EDf89322821FDC0f937Ad0527",
    prompt: "Ant Colony\n\nCreate a top-down resource collection game where the player controls an ant colony. Send ants toward food sources while avoiding spiders and other hazards. Food must be brought back to the nest before the timer expires. Increase the number of ants available as the player progresses."
  },
  {
    wallet: "0x9A10EB12296d38E359C489c10C024130F49ae077",
    prompt: "Time Freeze Thief\n\nCreate a 2D stealth game where the player controls a thief inside a museum. Guards move continuously, but the player can tap a button to freeze time for three seconds. Collect valuable artifacts and reach the exit without being caught."
  },
  {
    wallet: "0x5990941293E32fC9d7c6B05D7168a39f4E7bBedf",
    prompt: "Water the Garden\n\nCreate a relaxing hyper-casual game where the player controls a moving water hose. Drag the hose around a garden to water flowers while avoiding obstacles. Flowers bloom when fully watered and generate coins. Add increasingly complex garden layouts."
  },
  {
    wallet: "0xeD3D9F5B9d12F899adF62Ee20cdDA804C2ab5fc2",
    prompt: "Train Switch\n\nCreate a top-down railway management game where multiple trains approach intersections. The player taps railway switches to change their tracks and prevent collisions. Trains become faster and more frequent as the score increases."
  },
  {
    wallet: "0xF9275c98187850ac5Fb7a2FA42ebF09165f58Bb0",
    prompt: "Monster Merge Arena\n\nCreate a simple arena game where small monsters automatically fight waves of enemies. The player collects duplicate monsters and merges them into stronger versions between waves. Position the monsters strategically before each battle."
  }
  // Leftover prompt with no wallet (30th prompt, only 29 wallets given):
  // "Moon Gravity Basketball\n\nCreate a physics-based basketball game on the Moon. ..."
];

const API_BASE = process.env.SEED_API_BASE || `http://localhost:${process.env.PORT || 3001}`;
const ENDPOINT = `${API_BASE}/api/games/generate-from-prompt`;
const TIER = Number(process.env.SEED_TIER || 1);

const MIN_DELAY_MS = 1 * 60 * 1000; // 1 minute
const MAX_DELAY_MS = 30 * 60 * 1000; // 30 minutes

function randomDelayMs() {
  return MIN_DELAY_MS + Math.floor(Math.random() * (MAX_DELAY_MS - MIN_DELAY_MS + 1));
}

function formatDuration(ms) {
  const totalMinutes = Math.round(ms / 60000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function createGame({ wallet, prompt }) {
  const wallet_ = wallet.trim();
  const token = signToken({ userId: wallet_, evmWalletAddress: wallet_ });

  const response = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`
    },
    body: JSON.stringify({ prompt: prompt.trim(), tier: TIER })
  });

  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${body.error || JSON.stringify(body)}`);
  }
  return body;
}

// Runs forever, cycling through ENTRIES round-robin. Stop with Ctrl+C (or
// `kill` the process) — there is no natural end point.
async function main() {
  if (ENTRIES.length === 0) {
    console.error("ENTRIES is empty — add your { wallet, prompt } pairs at the top of this file.");
    process.exit(1);
  }

  console.log(`Continuously seeding games against ${ENDPOINT} (tier ${TIER}), cycling through ${ENTRIES.length} wallets`);
  console.log(`Random delay before each game: ${formatDuration(MIN_DELAY_MS)} – ${formatDuration(MAX_DELAY_MS)}\n`);

  let round = 1;
  let i = 0;
  for (;;) {
    if (i === 0 && round > 1) console.log(`\n--- round ${round}: back to the start of the wallet list ---\n`);

    const entry = ENTRIES[i];
    const label = `[round ${round}, ${i + 1}/${ENTRIES.length}] ${entry.wallet}`;
    console.log(`${label} — generating…`);
    try {
      const result = await createGame(entry);
      console.log(`${label} — OK, gameId=${result?.game?.id ?? "unknown"}`);
    } catch (error) {
      console.error(`${label} — FAILED: ${error.message}`);
    }

    const delay = randomDelayMs();
    const nextAt = new Date(Date.now() + delay);
    console.log(`  waiting ${formatDuration(delay)} until ${nextAt.toLocaleTimeString()}…\n`);
    await sleep(delay);

    i = (i + 1) % ENTRIES.length;
    if (i === 0) round += 1;
  }
}

main().catch((error) => {
  console.error("Fatal:", error);
  process.exit(1);
});
