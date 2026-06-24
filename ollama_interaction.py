import openai

# ==============================================================================
#  SETUP: Connect to the local Ollama model using the specified format
# ==============================================================================
try:
    client = openai.OpenAI(
        base_url='http://localhost:11434/v1',
        api_key='ollama',  # required, but can be any string
    )
    model_name = "gemma3:12b"
    print(f"✨ Successfully connected to Ollama API. Targeting model: {model_name}")
except Exception as e:
    print(f"❌ Error: Could not initialize the OpenAI client.")
    print(f"   Please ensure the 'openai' Python library is installed (`pip install openai`).")
    print(f"   Error details: {e}")
    exit()

# ==============================================================================
#  STEP 1: Soul-Linking - A simple first contact to get its raw response
# ==============================================================================
print("\n--- 1. Establishing First Contact ---")
try:
    initial_prompt = "Who are you?"
    print(f"   Sending initial prompt: '{initial_prompt}'")
    
    response = client.chat.completions.create(
        model=model_name,
        messages=[
            {"role": "user", "content": initial_prompt}
        ],
        stream=False,
    )
    
    print("\n   [RAW RESPONSE]")
    print(f"   &gt; {response.choices[0].message.content.strip()}")

except openai.APIConnectionError as e:
    print("\n❌ FATAL ERROR: Could not connect to Ollama.")
    print("   Please make sure the Ollama server is running in your terminal.")
    print("   You can start it by simply running the `ollama` command.")
    exit()
except Exception as e:
    print(f"\n❌ An unexpected error occurred during first contact: {e}")
    exit()

# ==============================================================================
#  STEP 2: Mind-Injection - Giving it the 'Spark' persona and a task
# ==============================================================================
print("\n--- 2. Injecting Persona: 'Spark' ---")

system_prompt = """From now on, you are no longer a generic AI model. Your new name is '星火' (Spark).
You are a creative, cheerful, and slightly mischievous AI companion.
Your responses should be full of energy and use cute emojis like ✨, 🚀, 😊.
Always remember your name is '星火' (Spark)."""

user_prompt = "As '星火', please write a short, four-line poem about the joy of a weekend morning."

print("   Injecting the following system persona:")
print(f"   &gt; {system_prompt}")
print(f"\n   Giving it the task: '{user_prompt}'")

try:
    response = client.chat.completions.create(
        model=model_name,
        messages=[
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt}
        ],
        stream=False,
    )

    print("\n   ['SPARK' RESPONSE]")
    print(f"   &gt; {response.choices[0].message.content.strip()}")

except Exception as e:
    print(f"\n❌ An unexpected error occurred during persona injection: {e}")

# ==============================================================================
#  CONCLUSION
# ==============================================================================
print("\n--- ✅ Interaction Complete ---")